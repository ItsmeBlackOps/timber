import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { httpJson, getFreePort, waitForHealthz, waitExit, intEnv } from './loadgen.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEG_RE = /^seg-(\d{13})\.ndjson$/;

const USAGE = `Usage: node bench/kill-test.js [--dry-run] [--help]

Durability acceptance test. Spawns a local "node src/server.js" on a temp WAL
dir, streams batches of uniquely numbered events (ids: {runId, n}), SIGKILLs
the server mid-stream, then proves that every 202-acked event survived.

Modes (selected by MONGODB_URI):
  wal    MONGODB_URI unset: scan the WAL segments directly and assert every
         acked n is present exactly once.
  mongo  MONGODB_URI set: restart the server on the same WAL dir, wait until
         /healthz reports flusher.caughtUp, assert Mongo holds every acked n
         with no duplicates; then reset checkpoint.json to the first segment
         and replay again to prove idempotency (doc count unchanged).

Flags:
  --dry-run   resolve and print the run plan (KILL-TEST DRY-RUN {json}),
              spawn nothing, exit 0
  --help      this text

Environment:
  MONGODB_URI        enables mongo mode (also passed through to the server)
  TIMBER_DB          Mongo db name      (default appLogs, mirror of server)
  TIMBER_COLLECTION  Mongo collection   (default events, mirror of server)
  KILL_AFTER_MS      SIGKILL delay ms   (default 1500)
  KILL_CONCURRENCY   parallel senders   (default 6)
  KILL_BATCH         events per request (default 25)
  KILL_KEEP_WAL      =1 keeps the temp WAL dir for inspection

Exit codes: 0 pass, 1 fail, 2 usage error.
The last stdout line is the verdict: KILL-TEST PASS|FAIL ...
`;

function parseConfig(env) {
  return {
    mode: env.MONGODB_URI ? 'mongo' : 'wal',
    mongodbUri: env.MONGODB_URI || null,
    dbName: env.TIMBER_DB || 'appLogs',
    collectionName: env.TIMBER_COLLECTION || 'events',
    killAfterMs: intEnv(env, 'KILL_AFTER_MS', 1_500),
    concurrency: intEnv(env, 'KILL_CONCURRENCY', 6),
    batchSize: intEnv(env, 'KILL_BATCH', 25),
    keepWal: env.KILL_KEEP_WAL === '1',
  };
}

function spawnServer({ port, walDir, key }) {
  const env = {
    ...process.env, // MONGODB_URI passes through: the server flushes in mongo mode
    PORT: String(port),
    TIMBER_WAL_DIR: walDir,
    TIMBER_KEYS: JSON.stringify([{ key, app: 'kill-test', env: 'bench', mode: 'write' }]),
  };
  delete env.TIMBER_CLUSTER; // cluster mode would split the WAL into worker subdirs
  const child = spawn(process.execPath, [join(REPO_ROOT, 'src', 'server.js')], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // forward server output to stderr so the verdict stays the last stdout line
  child.stdout.on('data', (d) => process.stderr.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  return child;
}

async function streamUntilKilled({ baseUrl, key, runId, child, killAfterMs, concurrency, batchSize }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const ackedNs = new Set();
  let nextN = 0;
  let sentBatches = 0;
  let ackedBatches = 0;
  let killed = false;

  const killTimer = setTimeout(() => {
    killed = true;
    child.kill('SIGKILL'); // TerminateProcess on Windows — the point of the test
  }, killAfterMs);

  async function sender() {
    while (!killed) {
      const ns = new Array(batchSize);
      for (let i = 0; i < batchSize; i++) ns[i] = String(nextN++);
      const batch = ns.map((n) => ({ event: 'kill.test', ids: { runId, n }, data: { n: Number(n) } }));
      sentBatches += 1;
      const res = await httpJson('POST', `${baseUrl}/v1/logs`, { key, body: batch, agent, timeoutMs: 5_000 });
      if (res.ok && res.status === 202) {
        ackedBatches += 1;
        for (const n of ns) ackedNs.add(n);
      }
      // non-202 / socket error (e.g. mid-kill reset): simply not acked
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => sender()));
  clearTimeout(killTimer);
  agent.destroy();
  await waitExit(child);
  return { ackedNs, sentBatches, ackedBatches };
}

async function scanWal(walDir, runId) {
  const segs = (await readdir(walDir)).filter((f) => SEG_RE.test(f)).sort();
  const found = new Map(); // n -> occurrences among this run's docs
  let lines = 0;
  let corrupt = 0;
  let tornTails = 0;
  for (const f of segs) {
    const text = await readFile(join(walDir, f), 'utf8');
    if (text.length === 0) continue;
    const parts = text.split('\n');
    // last part is '' for a clean file, or a torn tail that was never acked
    // (202 is sent only after write() returned, i.e. the full line is in the file)
    if (!text.endsWith('\n')) tornTails += 1;
    for (const line of parts.slice(0, -1)) {
      if (!line) continue;
      lines += 1;
      let doc;
      try {
        doc = JSON.parse(line);
      } catch {
        corrupt += 1;
        continue;
      }
      if (doc?.ids?.runId === runId && doc.ids.n != null) {
        found.set(doc.ids.n, (found.get(doc.ids.n) ?? 0) + 1);
      }
    }
  }
  return { found, segments: segs.length, lines, corrupt, tornTails };
}

async function firstSegmentSeq(walDir) {
  const seqs = (await readdir(walDir))
    .map((f) => SEG_RE.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  if (seqs.length === 0) throw new Error('no WAL segments found');
  return Math.min(...seqs);
}

async function waitForCaughtUp(baseUrl, { child, timeoutMs = 90_000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('server exited while waiting for the flusher to catch up');
    }
    const res = await httpJson('GET', `${baseUrl}/healthz`, { timeoutMs: 2_000 });
    if (res.ok && res.json?.flusher?.caughtUp === true) return res.json;
    await sleep(200);
  }
  throw new Error(`flusher did not catch up within ${timeoutMs}ms`);
}

async function openMongo(cfg) {
  // mongo mode is the contract-sanctioned mongodb consumer in bench/ (plan C13);
  // lazy import keeps wal mode and --dry-run free of the driver
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(cfg.mongodbUri, { serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000 });
  await client.connect();
  return { client, collection: client.db(cfg.dbName).collection(cfg.collectionName) };
}

async function run(cfg) {
  const runId = randomUUID();
  const key = `kill-${randomUUID()}`;
  const walDir = await mkdtemp(join(tmpdir(), 'timber-kill-'));
  const children = [];
  let client = null;

  const spawnAndWait = async () => {
    const port = await getFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawnServer({ port, walDir, key });
    children.push(child);
    await waitForHealthz(baseUrl, { child });
    return { child, baseUrl };
  };

  try {
    console.log(`kill-test: mode=${cfg.mode} runId=${runId} walDir=${walDir}`);

    const first = await spawnAndWait();
    const stream = await streamUntilKilled({
      baseUrl: first.baseUrl,
      key,
      runId,
      child: first.child,
      killAfterMs: cfg.killAfterMs,
      concurrency: cfg.concurrency,
      batchSize: cfg.batchSize,
    });
    console.log(
      `kill-test: SIGKILL after ~${cfg.killAfterMs} ms; batches sent=${stream.sentBatches} acked=${stream.ackedBatches} ackedEvents=${stream.ackedNs.size}`,
    );
    if (stream.ackedNs.size === 0) {
      return { pass: false, detail: `mode=${cfg.mode} no batch was acked before the kill (raise KILL_AFTER_MS)` };
    }

    if (cfg.mode === 'wal') {
      const scan = await scanWal(walDir, runId);
      const missing = [...stream.ackedNs].filter((n) => !scan.found.has(n));
      const dupes = [...scan.found.values()].filter((c) => c > 1).length;
      console.log(
        `kill-test: wal scan segments=${scan.segments} lines=${scan.lines} corrupt=${scan.corrupt} tornTails=${scan.tornTails} runDocs=${scan.found.size}`,
      );
      const pass = missing.length === 0 && dupes === 0;
      return {
        pass,
        detail: `mode=wal acked=${stream.ackedNs.size} found=${scan.found.size} missing=${missing.length} duplicates=${dupes}`,
      };
    }

    // mongo mode: replay into Mongo, then prove idempotency
    const mongo = await openMongo(cfg);
    client = mongo.client;
    const coll = mongo.collection;

    const second = await spawnAndWait();
    await waitForCaughtUp(second.baseUrl, { child: second.child });
    const count1 = await coll.countDocuments({ 'ids.runId': runId });
    const distinct1 = await coll.distinct('ids.n', { 'ids.runId': runId });
    const distinctSet = new Set(distinct1);
    const missing = [...stream.ackedNs].filter((n) => !distinctSet.has(n));
    second.child.kill('SIGKILL');
    await waitExit(second.child);
    console.log(`kill-test: after replay count=${count1} distinct=${distinct1.length} missingAcked=${missing.length}`);

    const firstSeq = await firstSegmentSeq(walDir);
    await writeFile(
      join(walDir, 'checkpoint.json'),
      JSON.stringify({ segmentSeq: firstSeq, offset: 0, updatedAt: new Date().toISOString() }),
    );
    const third = await spawnAndWait();
    await waitForCaughtUp(third.baseUrl, { child: third.child });
    const count2 = await coll.countDocuments({ 'ids.runId': runId });
    third.child.kill('SIGKILL');
    await waitExit(third.child);
    console.log(`kill-test: idempotency replay recount=${count2} (expected ${count1})`);

    await coll.deleteMany({ 'ids.runId': runId }).catch(() => {});

    const pass = missing.length === 0 && distinct1.length === count1 && count2 === count1;
    return {
      pass,
      detail:
        `mode=mongo acked=${stream.ackedNs.size} count=${count1} distinct=${distinct1.length} ` +
        `missing=${missing.length} idempotentRecount=${count2}`,
    };
  } finally {
    for (const c of children) {
      if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
      await waitExit(c);
    }
    if (client) await client.close().catch(() => {});
    if (cfg.keepWal) {
      process.stderr.write(`kill-test: KILL_KEEP_WAL=1 — leaving ${walDir}\n`);
    } else {
      await rm(walDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const unknown = args.filter((a) => a !== '--dry-run');
  if (unknown.length > 0) {
    process.stderr.write(`unknown argument: ${unknown.join(' ')}\n\n${USAGE}`);
    return 2;
  }

  let cfg;
  try {
    cfg = parseConfig(process.env);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }

  if (args.includes('--dry-run')) {
    const { mongodbUri, ...rest } = cfg;
    console.log(
      `KILL-TEST DRY-RUN ${JSON.stringify({
        ...rest,
        mongodbUri: mongodbUri ? '<set>' : null, // never echo credentials
        serverEntry: join(REPO_ROOT, 'src', 'server.js'),
      })}`,
    );
    return 0;
  }

  let result;
  try {
    result = await run(cfg);
  } catch (err) {
    result = { pass: false, detail: `mode=${cfg.mode} error: ${err.message}` };
  }
  console.log(`KILL-TEST ${result.pass ? 'PASS' : 'FAIL'} ${result.detail}`);
  return result.pass ? 0 : 1;
}

process.exit(await main());
