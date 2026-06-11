import http from 'node:http';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export function intEnv(env, name, def) {
  const raw = env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer (got ${JSON.stringify(raw)})`);
  }
  return n;
}

export function numEnv(env, name, def) {
  const raw = env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number (got ${JSON.stringify(raw)})`);
  }
  return n;
}

// Never rejects: resolves {ok:true,status,json} or {ok:false,error}.
export function httpJson(method, url, { key, body, agent, timeoutMs = 15_000 } = {}) {
  return new Promise((settle) => {
    const u = url instanceof URL ? url : new URL(url);
    if (u.protocol !== 'http:') {
      settle({ ok: false, error: new Error(`unsupported protocol ${u.protocol} (bench targets plain http)`) });
      return;
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (key) headers.authorization = `Bearer ${key}`;
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(payload.length);
    }
    let done = false;
    const finish = (result) => {
      if (!done) {
        done = true;
        settle(result);
      }
    };
    const req = http.request(u, { method, agent, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // non-JSON body: status code still useful
        }
        finish({ ok: true, status: res.statusCode, json });
      });
      res.on('error', (error) => finish({ ok: false, error }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)));
    req.on('error', (error) => finish({ ok: false, error }));
    req.end(payload ?? undefined);
  });
}

// Nearest-rank percentile over an ascending-sorted array; null when empty.
export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil(p * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

const round = (x, dp) => (x == null ? null : Math.round(x * 10 ** dp) / 10 ** dp);

const defaultEventFactory = (i) => ({ event: 'bench.load', message: `bench event ${i}`, data: { i } });

export async function runLoad({ url, key, durationMs, concurrency, batchSize, eventFactory = defaultEventFactory }) {
  if (!url) throw new TypeError('runLoad: url is required');
  for (const [name, v] of [['durationMs', durationMs], ['concurrency', concurrency], ['batchSize', batchSize]]) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`runLoad: ${name} must be a positive integer`);
  }
  const target = new URL(url);
  if (target.pathname === '/' || target.pathname === '') target.pathname = '/v1/logs';

  const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
  const latenciesMs = [];
  let sent = 0;      // events posted
  let accepted = 0;  // events the server reported accepted
  let acked = 0;     // requests that got 202
  let errors = 0;    // requests that failed (non-202 or transport error)
  let seq = 0;

  const startedAt = Date.now();
  const deadline = startedAt + durationMs;

  async function worker() {
    while (Date.now() < deadline) {
      const batch = new Array(batchSize);
      for (let i = 0; i < batchSize; i++) batch[i] = eventFactory(seq++);
      sent += batchSize;
      const t0 = process.hrtime.bigint();
      const res = await httpJson('POST', target, { key, body: batch, agent });
      if (res.ok && res.status === 202) {
        latenciesMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
        acked += 1;
        accepted += res.json?.accepted ?? batchSize;
      } else {
        errors += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedMs = Math.max(1, Date.now() - startedAt);
  agent.destroy();

  latenciesMs.sort((a, b) => a - b);
  return {
    sent,
    accepted,
    acked,
    errors,
    throughputPerSec: round(accepted / (elapsedMs / 1000), 1),
    ackP50Ms: round(percentile(latenciesMs, 0.5), 3),
    ackP99Ms: round(percentile(latenciesMs, 0.99), 3),
  };
}

export function getFreePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? rej(err) : res(port)));
    });
  });
}

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

export async function waitForHealthz(baseUrl, { timeoutMs = 15_000, child = null, pollMs = 120 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && hasExited(child)) {
      throw new Error(`server process exited (code ${child.exitCode}, signal ${child.signalCode}) before becoming healthy`);
    }
    const res = await httpJson('GET', `${baseUrl}/healthz`, { timeoutMs: 2_000 });
    if (res.ok && res.status === 200) return res.json;
    await sleep(pollMs);
  }
  throw new Error(`server did not answer /healthz within ${timeoutMs}ms`);
}

export function waitExit(child, timeoutMs = 5_000) {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((res) => {
    const timer = setTimeout(res, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      res();
    });
  });
}

export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    // lowercase: Windows drive-letter case varies between invocations
    return resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(metaUrl)).toLowerCase();
  } catch {
    return false;
  }
}

const USAGE = `Usage: node bench/loadgen.js [--help]

Library module (export { runLoad }) used by ingest-bench.js and kill-test.js.
Standalone mode fires a load at an already-running Timber server and prints
the raw runLoad result as JSON (no pass/fail thresholds — that is
ingest-bench's job).

Environment (standalone mode):
  TIMBER_URL        target base URL, e.g. http://127.0.0.1:7710 (required)
  TIMBER_KEY        write API key (required)
  LOAD_DURATION_MS  load duration ms      (default 5000)
  LOAD_CONCURRENCY  parallel connections  (default 10)
  LOAD_BATCH        events per request    (default 20)

Exit codes: 0 done, 2 usage error.
`;

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  if (args.length > 0) {
    process.stderr.write(`unknown argument: ${args.join(' ')}\n\n${USAGE}`);
    process.exit(2);
  }
  const { TIMBER_URL: url, TIMBER_KEY: key } = process.env;
  if (!url || !key) {
    process.stderr.write(`TIMBER_URL and TIMBER_KEY are required\n\n${USAGE}`);
    process.exit(2);
  }
  let cfg;
  try {
    cfg = {
      durationMs: intEnv(process.env, 'LOAD_DURATION_MS', 5_000),
      concurrency: intEnv(process.env, 'LOAD_CONCURRENCY', 10),
      batchSize: intEnv(process.env, 'LOAD_BATCH', 20),
    };
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
  const result = await runLoad({ url: url.replace(/\/+$/, ''), key, ...cfg });
  console.log(JSON.stringify(result));
}
