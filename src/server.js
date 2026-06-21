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
import { createSeqGenerator } from './ids.js';
import { createRouter } from './http/router.js';
import { readBody } from './http/body.js';
import { sendJson, sendError } from './http/respond.js';
import { createWalWriter } from './wal/writer.js';
import { loadCheckpoint } from './wal/checkpoint.js';
import { backlogBytes } from './wal/reader.js';
import { createFlusher } from './flusher.js';
import { connectMongo, ensureIndexes } from './mongo.js';
import { ensureProjectIndexes, listProjects, createProject, updateProject, deleteProject, validateProjectInput, resolveProjectApps } from './projects.js';
import { parseLogsQuery, runLogsQuery } from './query/logs.js';
import { parseStatsQuery, runStats } from './query/stats.js';
import { parseEventsQuery, runEvents } from './query/events.js';
import { parseFacetsQuery, runFacets } from './query/facets.js';
import { parseGroupByQuery, runGroupBy } from './query/groupby.js';

// Read once at startup (C11). Buffer, so content-length is exact bytes.
const UI_HTML = readFileSync(new URL('./ui/index.html', import.meta.url));

// Per-process sequence generator feeding deriveId via enrich (plan decision 1):
// identical envelopes in the same millisecond still get distinct _ids. The
// generator is process-unique (random nonce + counter), so cluster-mode workers
// (decision 9) sharing one Mongo collection never derive a colliding _id —
// otherwise the 2nd insert raises 11000 and the flusher silently drops a
// 202-accepted record (PRD §3/§9). See src/ids.js createSeqGenerator.
const nextSeq = createSeqGenerator();

const log = (msg) => process.stderr.write(`[timber] ${msg}\n`);

// /healthz is unauthenticated (Docker HEALTHCHECK + the UI's connection probe),
// so the flusher's raw lastError — which can carry WAL filesystem paths, the
// Mongo URI host, and db/collection names — must not be echoed verbatim. Collapse
// it to a coarse category that still tells an operator what class of failure is
// happening. Detailed errors remain in the server's stderr log.
function healthErrorCategory(msg) {
  if (!msg) return null;
  const s = String(msg);
  if (/E11000|duplicate key/i.test(s)) return 'duplicate key';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|server ?selection|topology|getaddrinfo|connect|refused|unreachable/i.test(s)) {
    return 'storage unreachable';
  }
  if (/timed out|timeout|exceeded time limit|maxTimeMS/i.test(s)) return 'storage timeout';
  if (/ENOSPC|EACCES|EPERM|EDQUOT|disk/i.test(s)) return 'wal write error';
  return 'flush error';
}

export function buildApp(config, deps) {
  const { keyring, walWriter, flusher, getCollection, getProjectsCollection, now } = deps;
  const router = createRouter();

  // Admission-time WAL budget accounting. walWriter.totalBytes() only reflects
  // bytes AFTER an append's write() resolves, so under concurrency many requests
  // would slip past an overBudget()-only gate while their appends are still in
  // flight, overshooting budgetBytes by ~(in-flight requests) x (per-request
  // bytes). We reserve a request's serialized size in `pendingBytes` the moment
  // we commit to appending, and release it once the append settles; the gate
  // checks total + pending, so the disk budget is honored at admission (PRD §7.3
  // "rather than risking the disk"; contract C5) with overshoot bounded to at
  // most one in-flight request.
  let pendingBytes = 0;
  // Serialize identically to src/wal/writer.js's append() so the reservation
  // matches the bytes that will actually land on disk.
  const payloadBytes = (docs) =>
    Buffer.byteLength(docs.map((d) => JSON.stringify(d) + '\n').join(''), 'utf8');

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

  // Pull an optional ?project=<slug> out of the query, resolve it to member apps,
  // and remove it so the per-endpoint parsers (which 400 on unknown params) never
  // see it. Returns { ok, apps }: apps is undefined (no scope) or an array, or the
  // call already sent 400 (unknown project) / 503 (no projects storage).
  async function resolveScope(url, res) {
    const slug = url.searchParams.get('project');
    if (slug === null) return { ok: true, apps: undefined };
    url.searchParams.delete('project');
    const pc = getProjectsCollection?.();
    if (!pc) { sendError(res, 503, 'storage unavailable'); return { ok: false }; }
    const apps = await resolveProjectApps(pc, slug, { maxTimeMS: config.queryMaxTimeMs });
    if (apps === null) { sendError(res, 400, `unknown project "${slug}"`); return { ok: false }; }
    return { ok: true, apps };
  }

  // Project-registry routes. Per design, a read key suffices for list AND mutate
  // (the read key already exposes all logs, so project metadata is not the weakest
  // link). Returns the projects collection or null after sending 401/503.
  function projectsGate(req, res) {
    const principal = keyring.authenticate(req.headers.authorization);
    if (!canRead(principal)) { unauthorized(res); return null; }
    const pc = getProjectsCollection?.();
    if (!pc) { sendError(res, 503, 'storage unavailable'); return null; }
    return pc;
  }

  async function readJsonBody(req, res) {
    const body = await readBody(req, config.maxBodyBytes);
    if (!body.ok) { sendError(res, body.status, 'request body too large'); return undefined; }
    try { return JSON.parse(body.buffer.toString('utf8')); }
    catch { sendError(res, 400, 'request body is not valid JSON'); return undefined; }
  }

  router.add('GET', '/v1/projects', async (req, res) => {
    const pc = projectsGate(req, res); if (!pc) return;
    sendJson(res, 200, { projects: await listProjects(pc, { maxTimeMS: config.queryMaxTimeMs }) });
  });

  router.add('POST', '/v1/projects', async (req, res) => {
    const pc = projectsGate(req, res); if (!pc) return;
    const raw = await readJsonBody(req, res); if (raw === undefined) return;
    const v = validateProjectInput(raw, { partial: false });
    if (!v.ok) return sendError(res, 400, v.error);
    const created = await createProject(pc, v.value, { now });
    if (!created.ok) return sendError(res, 409, 'project name already exists');
    sendJson(res, 201, created.value);
  });

  router.add('PATCH', '/v1/projects', async (req, res) => {
    const pc = projectsGate(req, res); if (!pc) return;
    const raw = await readJsonBody(req, res); if (raw === undefined) return;
    if (!raw || typeof raw !== 'object' || typeof raw.slug !== 'string' || raw.slug.length === 0) {
      return sendError(res, 400, 'slug is required');
    }
    const { slug, ...rest } = raw;
    const v = validateProjectInput(rest, { partial: true });
    if (!v.ok) return sendError(res, 400, v.error);
    const updated = await updateProject(pc, slug, v.value, { now });
    if (updated.notFound) return sendError(res, 404, 'project not found');
    if (updated.conflict) return sendError(res, 409, 'project name already exists');
    sendJson(res, 200, updated.value);
  });

  router.add('DELETE', '/v1/projects', async (req, res, url) => {
    const pc = projectsGate(req, res); if (!pc) return;
    const slug = url.searchParams.get('slug');
    if (!slug) return sendError(res, 400, 'slug query parameter is required');
    const ok = await deleteProject(pc, slug);
    if (!ok) return sendError(res, 404, 'project not found');
    res.writeHead(204); res.end();
  });

  router.add('GET', '/healthz', async (req, res) => {
    const checkpoint = await loadCheckpoint(config.walDir);
    const backlog = await backlogBytes(config.walDir, checkpoint);
    const fstatus = flusher.status();
    sendJson(res, 200, {
      ok: true,
      wal: {
        totalBytes: walWriter.totalBytes(),
        backlogBytes: backlog,
        overBudget: walWriter.overBudget(),
      },
      flusher: { ...fstatus, lastError: healthErrorCategory(fstatus.lastError) },
      mongo: { connected: getCollection() != null },
    });
  });

  router.add('POST', '/v1/logs', async (req, res) => {
    const principal = keyring.authenticate(req.headers.authorization);
    if (!principal) return unauthorized(res);
    if (!canWrite(principal)) return sendError(res, 403, 'write key required');

    // Admission gate + reservation. The gate must account for bytes already
    // committed to (total) PLUS bytes reserved by concurrently-admitted requests
    // whose appends are still in flight (pendingBytes) PLUS an estimate of THIS
    // request's bytes — otherwise a synchronous burst all reads pending==0 at the
    // gate and overshoots. Honest senders declare content-length, which bounds the
    // payload; we reserve that synchronously (no await before the increment) so the
    // next request in the same tick sees it, then reconcile to the exact serialized
    // size after enrichment. A single finally releases the reservation on every
    // exit path (reject or success), since on a rejected/failed path the bytes
    // never reach the WAL and on success walWriter.totalBytes() has absorbed them.
    const declared = Number(req.headers['content-length']);
    const estimate =
      Number.isFinite(declared) && declared > 0 ? Math.min(declared, config.maxBodyBytes) : 0;
    if (walWriter.overBudget() || walWriter.totalBytes() + pendingBytes + estimate >= config.walBudgetBytes) {
      return sendJson(res, 429, { error: 'wal budget exceeded' }, { 'retry-after': '5' });
    }
    let reserved = estimate;
    pendingBytes += reserved;
    try {
      // Honest senders declare content-length: reject oversize before reading the
      // payload. We must still drain the in-flight upload before ending the
      // response, otherwise forcing the socket shut mid-upload RSTs the client's
      // outbound write and it sees ECONNRESET instead of the clean 413 it is owed
      // (contract C11, USAGE.md). Resume to discard the bytes, then send the 413
      // once the body is fully consumed; the keep-alive socket stays usable.
      if (Number.isFinite(declared) && declared > config.maxBodyBytes) {
        const reply = () => {
          if (!res.headersSent) sendJson(res, 413, { error: 'request body too large' });
        };
        req.on('end', reply);
        req.on('close', reply); // client aborted first: socket is already gone, no-op send
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
      // Reconcile the reservation to the exact bytes that will be written (the
      // enriched docs are larger than the raw body); keeps total + pending exact.
      const actual = payloadBytes(docs);
      pendingBytes += actual - reserved;
      reserved = actual;
      await walWriter.append(docs); // resolves once the events are in the OS buffer of the WAL
      sendJson(res, 202, { accepted: docs.length });
    } finally {
      pendingBytes -= reserved;
    }
  });

  router.add('GET', '/v1/logs', async (req, res, url) => {
    const collection = readGate(req, res);
    if (!collection) return;
    const scope = await resolveScope(url, res);
    if (!scope.ok) return;
    const parsed = parseLogsQuery(url.searchParams);
    if (!parsed.ok) return sendError(res, 400, parsed.error);
    parsed.value.apps = scope.apps;
    sendJson(res, 200, await runLogsQuery(collection, parsed.value, { maxTimeMS: config.queryMaxTimeMs }));
  });

  router.add('GET', '/v1/stats', async (req, res, url) => {
    const collection = readGate(req, res);
    if (!collection) return;
    const scope = await resolveScope(url, res);
    if (!scope.ok) return;
    const parsed = parseStatsQuery(url.searchParams);
    if (!parsed.ok) return sendError(res, 400, parsed.error);
    parsed.value.apps = scope.apps;
    sendJson(res, 200, await runStats(collection, parsed.value, { maxTimeMS: config.queryMaxTimeMs }));
  });

  router.add('GET', '/v1/events', async (req, res, url) => {
    const collection = readGate(req, res);
    if (!collection) return;
    const scope = await resolveScope(url, res);
    if (!scope.ok) return;
    const parsed = parseEventsQuery(url.searchParams);
    if (!parsed.ok) return sendError(res, 400, parsed.error);
    parsed.value.apps = scope.apps;
    sendJson(res, 200, await runEvents(collection, parsed.value, { maxTimeMS: config.queryMaxTimeMs }));
  });

  router.add('GET', '/v1/facets', async (req, res, url) => {
    const collection = readGate(req, res);
    if (!collection) return;
    const scope = await resolveScope(url, res);
    if (!scope.ok) return;
    const parsed = parseFacetsQuery(url.searchParams);
    if (!parsed.ok) return sendError(res, 400, parsed.error);
    parsed.value.apps = scope.apps;
    sendJson(res, 200, await runFacets(collection, parsed.value, { maxTimeMS: config.queryMaxTimeMs }));
  });

  router.add('GET', '/v1/groupby', async (req, res, url) => {
    const collection = readGate(req, res);
    if (!collection) return;
    const scope = await resolveScope(url, res);
    if (!scope.ok) return;
    const parsed = parseGroupByQuery(url.searchParams);
    if (!parsed.ok) return sendError(res, 400, parsed.error);
    parsed.value.apps = scope.apps;
    sendJson(res, 200, await runGroupBy(collection, parsed.value, { maxTimeMS: config.queryMaxTimeMs }));
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

  // Socket hardening. The POST /v1/logs admission gate reserves a request's
  // declared content-length in pendingBytes the instant it commits to appending
  // and only releases it once readBody settles (success or abort). Node's default
  // requestTimeout (300_000ms) lets a client that declares a large body and then
  // trickles or stalls it pin that reservation for ~5 minutes, forcing honest
  // concurrent writers to 429 'wal budget exceeded'. Capping requestTimeout (whole
  // request) and headersTimeout (header phase) to conservative finite budgets
  // makes the server reap a stalled upload in seconds — Node answers 408 / resets
  // the socket, readBody's close/abort handler fires, and the finally releases
  // pendingBytes. Both are config-driven (TIMBER_REQUEST_TIMEOUT_MS /
  // TIMBER_HEADERS_TIMEOUT_MS) and never 0 (0 = unlimited, which reintroduces the
  // bug).
  server.requestTimeout = config.requestTimeoutMs;
  server.headersTimeout = config.headersTimeoutMs;
  // CRITICAL: Node only sweeps for requestTimeout/headersTimeout violations once
  // per connectionsCheckingInterval (default 30_000ms). With the default, a small
  // requestTimeout is effectively ignored until the next 30s tick — the stalled
  // upload would keep its reservation for up to ~30s regardless of a 400ms
  // requestTimeout. We tighten the sweep to a quarter of the smaller timeout
  // (floored at 100ms so we never busy-spin) so reaping actually tracks the
  // configured budget: e.g. requestTimeout=30_000 sweeps ~every 3.75s; the test's
  // requestTimeout=400 sweeps ~every 100ms and reaps in well under a second.
  server.connectionsCheckingInterval = Math.max(
    100,
    Math.floor(Math.min(config.requestTimeoutMs, config.headersTimeoutMs) / 4),
  );

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
  let projectsCollection = null;
  let stopping = false;
  const getCollection = () => collection;
  const getProjectsCollection = () => projectsCollection;

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
    getProjectsCollection,
    now: () => new Date(),
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.port, config.host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  log(`listening on ${config.host}:${config.port} (wal: ${config.walDir})`);

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
          const projects = conn.client.db(config.mongoDbName).collection(config.mongoProjectsCollectionName);
          await ensureProjectIndexes(projects);
          client = conn.client;
          collection = conn.collection;
          projectsCollection = projects;
          log(`mongo connected (db=${config.mongoDbName} collection=${config.mongoCollectionName}, projects=${config.mongoProjectsCollectionName})`);
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
