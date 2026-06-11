// Timber server (contract C11): wires config, auth, validation, WAL, flusher,
// Mongo and the query modules behind a pure node:http server.
//
//   buildApp(config, deps) -> { server, shutdown }   (DI for tests)
//   main()                                           (node src/server.js entry)
import cluster from 'node:cluster';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.js';
import { createKeyring, canWrite, canRead } from './auth.js';
import { validateBatch, enrich } from './validate.js';
import { createRouter } from './http/router.js';
import { readBody } from './http/body.js';
import { sendJson, sendError } from './http/respond.js';
import { createWalWriter } from './wal/writer.js';
import { loadCheckpoint } from './wal/checkpoint.js';
import { backlogBytes } from './wal/reader.js';
import { createFlusher } from './flusher.js';
import { connectMongo, ensureIndexes } from './mongo.js';
import { parseLogsQuery, runLogsQuery } from './query/logs.js';
import { parseStatsQuery, runStats } from './query/stats.js';
import { runEvents } from './query/events.js';

// Read once at startup (C11). Buffer, so content-length is exact bytes.
const UI_HTML = readFileSync(new URL('./ui/index.html', import.meta.url));

// Per-process sequence counter feeding deriveId via enrich (plan decision 1):
// identical envelopes in the same millisecond still get distinct _ids.
let processSeq = 0;
const nextSeq = () => processSeq++;

const log = (msg) => process.stderr.write(`[timber] ${msg}\n`);

export function buildApp(config, deps) {
  const { keyring, walWriter, flusher, getCollection, now } = deps;
  const router = createRouter();

  const unauthorized = (res) => sendJson(res, 401, { error: 'unknown key' }, { 'www-authenticate': 'Bearer' });

  // Shared guard for the read-or-write query routes. Returns the collection or
  // null after having sent the 401/503 response itself.
  function readGate(req, res) {
    const principal = keyring.authenticate(req.headers.authorization);
    if (!canRead(principal)) {
      unauthorized(res);
      return null;
    }
    const collection = getCollection();
    if (!collection) {
      sendError(res, 503, 'storage unavailable');
      return null;
    }
    return collection;
  }

  router.add('GET', '/healthz', async (req, res) => {
    const checkpoint = await loadCheckpoint(config.walDir);
    const backlog = await backlogBytes(config.walDir, checkpoint);
    sendJson(res, 200, {
      ok: true,
      wal: {
        totalBytes: walWriter.totalBytes(),
        backlogBytes: backlog,
        overBudget: walWriter.overBudget(),
      },
      flusher: flusher.status(),
      mongo: { connected: getCollection() != null },
    });
  });

  router.add('POST', '/v1/logs', async (req, res) => {
    const principal = keyring.authenticate(req.headers.authorization);
    if (!principal) return unauthorized(res);
    if (!canWrite(principal)) return sendError(res, 403, 'write key required');

    if (walWriter.overBudget()) {
      return sendJson(res, 429, { error: 'wal budget exceeded' }, { 'retry-after': '5' });
    }

    // Honest senders declare content-length: reject oversize before reading,
    // with a clean 413 (the body is drained so the response is deliverable).
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
      sendJson(res, 413, { error: 'request body too large' }, { connection: 'close' });
      req.resume();
      return;
    }

    const body = await readBody(req, config.maxBodyBytes);
    if (!body.ok) {
      // readBody destroyed the request on overflow; this response is best-effort.
      return sendError(res, body.status, 'request body too large');
    }

    let parsed;
    try {
      parsed = JSON.parse(body.buffer.toString('utf8'));
    } catch {
      return sendError(res, 400, 'request body is not valid JSON');
    }

    const batch = validateBatch(parsed, config);
    if (!batch.ok) {
      return sendError(res, batch.status, batch.error, batch.index === undefined ? {} : { index: batch.index });
    }

    const receivedAtIso = now().toISOString(); // one server timestamp per request
    const docs = batch.events.map((value) =>
      enrich(value, {
        app: principal.app,
        env: principal.env,
        receivedAtIso,
        seq: nextSeq(),
        ttlDays: config.ttlDays,
      }),
    );
    await walWriter.append(docs); // resolves once the events are in the OS buffer of the WAL
    sendJson(res, 202, { accepted: docs.length });
  });

  router.add('GET', '/v1/logs', async (req, res, url) => {
    const collection = readGate(req, res);
    if (!collection) return;
    const parsed = parseLogsQuery(url.searchParams);
    if (!parsed.ok) return sendError(res, 400, parsed.error);
    sendJson(res, 200, await runLogsQuery(collection, parsed.value));
  });

  router.add('GET', '/v1/stats', async (req, res, url) => {
    const collection = readGate(req, res);
    if (!collection) return;
    const parsed = parseStatsQuery(url.searchParams);
    if (!parsed.ok) return sendError(res, 400, parsed.error);
    sendJson(res, 200, await runStats(collection, parsed.value));
  });

  router.add('GET', '/v1/events', async (req, res, url) => {
    const collection = readGate(req, res);
    if (!collection) return;
    sendJson(res, 200, await runEvents(collection, { app: url.searchParams.get('app') ?? undefined }));
  });

  router.add('GET', '/', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': UI_HTML.length,
    });
    res.end(UI_HTML);
  });

  const server = createServer((req, res) => {
    Promise.resolve(router.dispatch(req, res)).catch((err) => {
      log(`request failed: ${err?.stack ?? err}`);
      if (!res.headersSent) sendError(res, 500, 'internal error');
      else res.destroy();
    });
  });

  async function shutdown() {
    if (server.listening) {
      await new Promise((resolveClose) => {
        server.close(() => resolveClose());
        server.closeIdleConnections?.();
      });
    }
    await flusher.stop();
    await walWriter.close();
  }

  return { server, shutdown };
}

export async function main() {
  const config = loadConfig();

  if (config.clusterWorkers > 0 && cluster.isPrimary) {
    log(`cluster mode: forking ${config.clusterWorkers} workers`);
    for (let i = 0; i < config.clusterWorkers; i++) {
      cluster.fork({ TIMBER_WAL_DIR: join(config.walDir, `worker-${i}`) });
    }
    cluster.on('exit', (worker, code, signal) => {
      log(`worker ${worker.process.pid} exited (code=${code} signal=${signal ?? 'none'})`);
    });
    return;
  }

  const walWriter = await createWalWriter({
    dir: config.walDir,
    fsyncMs: config.walFsyncMs,
    segmentMaxBytes: config.walSegmentMaxBytes,
    budgetBytes: config.walBudgetBytes,
    retainHours: config.walRetainHours,
  });
  const keyring = createKeyring(config.keys);

  let client = null;
  let collection = null;
  let stopping = false;
  const getCollection = () => collection;

  const flusher = createFlusher({
    walDir: config.walDir,
    getCollection,
    batchSize: config.flushBatchSize,
    intervalMs: config.flushIntervalMs,
    log,
  });

  const { server, shutdown } = buildApp(config, {
    keyring,
    walWriter,
    flusher,
    getCollection,
    now: () => new Date(),
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.port, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  log(`listening on :${config.port} (wal: ${config.walDir})`);

  // Background Mongo connect loop: ingest never waits on storage (PRD §7.3).
  if (config.mongodbUri) {
    (async () => {
      while (!stopping && !collection) {
        try {
          const conn = await connectMongo(config.mongodbUri, {
            dbName: config.mongoDbName,
            collectionName: config.mongoCollectionName,
          });
          await ensureIndexes(conn.collection);
          client = conn.client;
          collection = conn.collection;
          log(`mongo connected (db=${config.mongoDbName} collection=${config.mongoCollectionName})`);
        } catch (err) {
          log(`mongo connect failed: ${err?.message ?? err} — retrying in 5s`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      }
    })();
  } else {
    log('MONGODB_URI not set — queries answer 503, flusher idles, WAL still accepts');
  }

  flusher.start();

  const janitorTimer = setInterval(async () => {
    try {
      const checkpoint = await loadCheckpoint(config.walDir);
      const { deleted } = await walWriter.janitor(checkpoint);
      if (deleted.length > 0) log(`janitor: deleted ${deleted.join(', ')}`);
    } catch (err) {
      log(`janitor failed: ${err?.message ?? err}`);
    }
  }, 60_000);
  janitorTimer.unref();

  const onSignal = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received — shutting down`);
    clearInterval(janitorTimer);
    try {
      await shutdown(); // server.close -> flusher.stop -> walWriter.close
      await client?.close();
    } catch (err) {
      log(`shutdown error: ${err?.message ?? err}`);
    }
    log('bye');
    process.exit(0);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

const isDirectRun =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((err) => {
    log(`fatal: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
