import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoad, getFreePort, waitForHealthz, waitExit, intEnv, numEnv } from './loadgen.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

const USAGE = `Usage: node bench/ingest-bench.js [--help]

Ingest throughput benchmark. Unless TIMBER_URL is set it spawns a local
"node src/server.js" with a temp WAL dir and a generated write key (no Mongo:
the ingest hot path is WAL-only), waits for /healthz, fires concurrent
POST /v1/logs batches, then checks the thresholds.

Environment:
  TIMBER_URL         benchmark an already-running server instead of spawning
                     one (requires TIMBER_KEY; plain http only)
  TIMBER_KEY         write key, used only with TIMBER_URL
  BENCH_DURATION_MS  load duration ms        (default 10000; smoke 2000)
  BENCH_CONCURRENCY  parallel connections    (default 50)
  BENCH_BATCH        events per request      (default 20)
  BENCH_MIN_RATE     min accepted events/s   (default 2000; smoke 500)
  BENCH_MAX_P99      max ack p99 latency ms  (default 25;   smoke 100)
  BENCH_SMOKE        =1 selects the CI-friendly smoke defaults above
                     (explicit BENCH_* values still win)

Exit codes: 0 pass, 1 fail (thresholds missed or bench could not run), 2 usage.
The last stdout line is machine-readable: BENCH {json}
`;

function parseConfig(env) {
  const smoke = env.BENCH_SMOKE === '1';
  return {
    smoke,
    durationMs: intEnv(env, 'BENCH_DURATION_MS', smoke ? 2_000 : 10_000),
    concurrency: intEnv(env, 'BENCH_CONCURRENCY', 50),
    batchSize: intEnv(env, 'BENCH_BATCH', 20),
    minRate: numEnv(env, 'BENCH_MIN_RATE', smoke ? 500 : 2_000),
    maxP99: numEnv(env, 'BENCH_MAX_P99', smoke ? 100 : 25),
    externalUrl: env.TIMBER_URL ? env.TIMBER_URL.replace(/\/+$/, '') : null,
    externalKey: env.TIMBER_KEY || null,
  };
}

function spawnServer({ port, walDir, key }) {
  const env = {
    ...process.env,
    PORT: String(port),
    TIMBER_WAL_DIR: walDir,
    TIMBER_KEYS: JSON.stringify([{ key, app: 'bench', env: 'bench', mode: 'write' }]),
  };
  // WAL-only bench: never let the spawned server reach a real Mongo, and keep
  // it single-process so one WAL dir and one port are enough.
  delete env.MONGODB_URI;
  delete env.TIMBER_CLUSTER;
  const child = spawn(process.execPath, [join(REPO_ROOT, 'src', 'server.js')], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // forward server output to stderr so BENCH {json} stays the last stdout line
  child.stdout.on('data', (d) => process.stderr.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  return child;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.length > 0) {
    process.stderr.write(`unknown argument: ${args.join(' ')}\n\n${USAGE}`);
    return 2;
  }

  let cfg;
  try {
    cfg = parseConfig(process.env);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  if (cfg.externalUrl && !cfg.externalKey) {
    process.stderr.write('TIMBER_URL is set but TIMBER_KEY is missing\n');
    return 2;
  }

  let child = null;
  let walDir = null;
  const cleanup = async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (child) await waitExit(child);
    if (walDir) await rm(walDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  };

  try {
    let baseUrl;
    let key;
    if (cfg.externalUrl) {
      baseUrl = cfg.externalUrl;
      key = cfg.externalKey;
      await waitForHealthz(baseUrl, { timeoutMs: 5_000 });
    } else {
      key = `bench-${randomUUID()}`;
      walDir = await mkdtemp(join(tmpdir(), 'timber-bench-'));
      const port = await getFreePort();
      baseUrl = `http://127.0.0.1:${port}`;
      child = spawnServer({ port, walDir, key });
      await waitForHealthz(baseUrl, { child });
    }

    console.log(
      `ingest-bench: ${cfg.durationMs} ms, ${cfg.concurrency} connections, batch ${cfg.batchSize} -> ${baseUrl}${cfg.smoke ? ' (smoke)' : ''}`,
    );

    const result = await runLoad({
      url: `${baseUrl}/v1/logs`,
      key,
      durationMs: cfg.durationMs,
      concurrency: cfg.concurrency,
      batchSize: cfg.batchSize,
      eventFactory: (i) => ({
        event: 'bench.load',
        level: 'info',
        message: `bench event ${i}`,
        data: { i, latencyMs: 5 + (i % 40), status: 200 },
      }),
    });

    const reasons = [];
    if (result.acked === 0) reasons.push('no request was acked');
    if (result.throughputPerSec < cfg.minRate) reasons.push(`throughput ${result.throughputPerSec} < ${cfg.minRate} ev/s`);
    if (result.ackP99Ms == null || result.ackP99Ms > cfg.maxP99) reasons.push(`ackP99 ${result.ackP99Ms} > ${cfg.maxP99} ms`);
    const pass = reasons.length === 0;

    console.log(`  sent=${result.sent} accepted=${result.accepted} acked=${result.acked} errors=${result.errors}`);
    console.log(
      `  throughput=${result.throughputPerSec} ev/s (min ${cfg.minRate})  ackP50=${result.ackP50Ms} ms  ackP99=${result.ackP99Ms} ms (max ${cfg.maxP99})`,
    );
    console.log(pass ? 'ingest-bench: PASS' : `ingest-bench: FAIL — ${reasons.join('; ')}`);

    await cleanup();
    console.log(
      `BENCH ${JSON.stringify({
        pass,
        ...result,
        durationMs: cfg.durationMs,
        concurrency: cfg.concurrency,
        batchSize: cfg.batchSize,
        minRate: cfg.minRate,
        maxP99: cfg.maxP99,
        smoke: cfg.smoke,
      })}`,
    );
    return pass ? 0 : 1;
  } catch (err) {
    await cleanup();
    process.stderr.write(`ingest-bench: ${err.message}\n`);
    console.log(`BENCH ${JSON.stringify({ pass: false, error: err.message })}`);
    return 1;
  }
}

process.exit(await main());
