// Task 16 — contract C11: buildApp(config, deps) route/status table, exercised
// over real HTTP on an ephemeral port with fully fake deps (DI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { createKeyring } from '../src/auth.js';
import { buildApp } from '../src/server.js';
import { createFakeCollection } from './helpers/fake-collection.js';
import { mkTmpDir, rmTmpDir } from './helpers/tmp.js';

const WRITE_KEY = 'test-write-key-0123456789abcdef';
const READ_KEY = 'test-read-key-0123456789abcdef';
const FIXED_ISO = '2026-06-11T12:00:00.000Z';

function makeFakeWalWriter() {
  const fake = {
    appended: [], // one entry per append() call (the docs array)
    over: false,
    closed: false,
    append: async (docs) => {
      fake.appended.push(docs);
    },
    totalBytes: () => 1234,
    overBudget: () => fake.over,
    activeSegmentSeq: () => 1,
    forceFsync: async () => {},
    janitor: async () => ({ deleted: [] }),
    close: async () => {
      fake.closed = true;
    },
  };
  return fake;
}

// A fake WAL writer that reproduces the real writer's budget-timing surface:
// totalBytes()/overBudget() reflect bytes ONLY after an append resolves, and
// appends can be held in-flight via a manual gate. This lets a test reproduce
// the "concurrent in-flight appends overshoot the budget" finding deterministically,
// without depending on src/wal/writer.js internals.
function makeGatedWalWriter(budgetBytes) {
  let total = 0;
  const releases = []; // resolve fns for appends currently held in flight
  const fake = {
    appended: [], // docs arrays, in admission (append-call) order
    bytesPerAppend: [], // bytes the real writer would persist, per append
    // Serialize docs exactly like src/wal/writer.js so byte accounting matches.
    sizeOf: (docs) =>
      Buffer.byteLength(docs.map((d) => JSON.stringify(d) + '\n').join(''), 'utf8'),
    append(docs) {
      fake.appended.push(docs);
      const bytes = fake.sizeOf(docs);
      fake.bytesPerAppend.push(bytes);
      return new Promise((resolve) => {
        releases.push(() => {
          total += bytes; // the real writer bumps `total` only here, post-write
          resolve();
        });
      });
    },
    releaseAll() {
      for (const fn of releases.splice(0)) fn();
    },
    held: () => releases.length,
    totalBytes: () => total,
    overBudget: () => total >= budgetBytes,
    activeSegmentSeq: () => 1,
    forceFsync: async () => {},
    janitor: async () => ({ deleted: [] }),
    closed: false,
    close: async () => {
      fake.closed = true;
    },
  };
  return fake;
}

function makeFakeFlusher() {
  const fake = {
    started: false,
    stopped: false,
    start() {
      fake.started = true;
    },
    stop: async () => {
      fake.stopped = true;
    },
    status: () => ({ running: true, caughtUp: false, lastError: null, flushedTotal: 7 }),
  };
  return fake;
}

// Builds a full app on an ephemeral port with fake deps; auto-teardown via t.after.
async function makeApp(
  t,
  {
    collection = null,
    now = () => new Date(FIXED_ISO),
    walWriter: walWriterOverride,
    budgetMb,
    flusher: flusherOverride,
  } = {},
) {
  const walDir = await mkTmpDir('timber-server-test-');
  const config = loadConfig({
    TIMBER_WAL_DIR: walDir,
    ...(budgetMb === undefined ? {} : { TIMBER_WAL_BUDGET_MB: String(budgetMb) }),
    TIMBER_KEYS: JSON.stringify([
      { key: WRITE_KEY, app: 'appA', env: 'prod', mode: 'write' },
      { key: READ_KEY, app: 'reader', env: 'prod', mode: 'read' },
    ]),
  });
  const walWriter = walWriterOverride ?? makeFakeWalWriter();
  const flusher = flusherOverride ?? makeFakeFlusher();
  let coll = collection;
  const { server, shutdown } = buildApp(config, {
    keyring: createKeyring(config.keys),
    walWriter,
    flusher,
    getCollection: () => coll,
    now,
  });
  assert.equal(server.listening, false, 'buildApp must return a non-listening server');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    // Release any appends a gated writer is still holding, so hung requests can
    // finish and server.close() (inside shutdown) can resolve even on a failed
    // assertion — otherwise the test process would never exit.
    walWriter.releaseAll?.();
    await shutdown();
    await rmTmpDir(walDir);
  });
  return {
    port: server.address().port,
    server,
    shutdown,
    walWriter,
    flusher,
    walDir,
    setCollection: (c) => {
      coll = c;
    },
  };
}

function req(port, method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    r.on('error', reject);
    if (body !== null) r.write(body);
    r.end();
  });
}

const jsonOf = (r) => JSON.parse(r.text);
const auth = (key) => ({ authorization: `Bearer ${key}` });

function postLogs(port, key, payload, extraHeaders = {}) {
  return req(port, 'POST', '/v1/logs', {
    headers: {
      'content-type': 'application/json',
      ...(key ? auth(key) : {}),
      ...extraHeaders,
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

// --- healthz ---------------------------------------------------------------

test('GET /healthz needs no auth and reports wal/flusher/mongo state', async (t) => {
  const app = await makeApp(t);
  // a pre-existing segment beyond the (zero) checkpoint must show up as backlog
  writeFileSync(join(app.walDir, 'seg-0000000000001.ndjson'), 'x'.repeat(100));

  const r = await req(app.port, 'GET', '/healthz');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^application\/json/);
  const body = jsonOf(r);
  assert.equal(body.ok, true);
  assert.deepEqual(body.wal, { totalBytes: 1234, backlogBytes: 100, overBudget: false });
  assert.deepEqual(body.flusher, {
    running: true,
    caughtUp: false,
    lastError: null,
    flushedTotal: 7,
  });
  assert.deepEqual(body.mongo, { connected: false });
});

test('GET /healthz reflects mongo connection and wal overBudget', async (t) => {
  const app = await makeApp(t, { collection: createFakeCollection() });
  app.walWriter.over = true;
  const body = jsonOf(await req(app.port, 'GET', '/healthz'));
  assert.equal(body.mongo.connected, true);
  assert.equal(body.wal.overBudget, true);
});

// --- POST /v1/logs: auth ----------------------------------------------------

test('POST /v1/logs without a key is 401 with WWW-Authenticate: Bearer', async (t) => {
  const app = await makeApp(t);
  const r = await postLogs(app.port, null, { event: 'x' });
  assert.equal(r.status, 401);
  assert.equal(r.headers['www-authenticate'], 'Bearer');
  assert.equal(typeof jsonOf(r).error, 'string');
  assert.equal(app.walWriter.appended.length, 0);
});

test('POST /v1/logs with an unknown key is 401', async (t) => {
  const app = await makeApp(t);
  const r = await postLogs(app.port, 'not-a-real-key', { event: 'x' });
  assert.equal(r.status, 401);
  assert.equal(r.headers['www-authenticate'], 'Bearer');
});

test('POST /v1/logs with a read key is 403', async (t) => {
  const app = await makeApp(t);
  const r = await postLogs(app.port, READ_KEY, { event: 'x' });
  assert.equal(r.status, 403);
  assert.equal(typeof jsonOf(r).error, 'string');
  assert.equal(app.walWriter.appended.length, 0);
});

// --- POST /v1/logs: backpressure + body limits -------------------------------

test('POST /v1/logs over WAL budget is 429 with Retry-After: 5', async (t) => {
  const app = await makeApp(t);
  app.walWriter.over = true;
  const r = await postLogs(app.port, WRITE_KEY, { event: 'x' });
  assert.equal(r.status, 429);
  assert.equal(r.headers['retry-after'], '5');
  assert.deepEqual(jsonOf(r), { error: 'wal budget exceeded' });
});

test('429 takes precedence over body parsing', async (t) => {
  const app = await makeApp(t);
  app.walWriter.over = true;
  const r = await postLogs(app.port, WRITE_KEY, 'this is not json{');
  assert.equal(r.status, 429);
});

test('POST /v1/logs with declared body > 1 MB is 413', async (t) => {
  const app = await makeApp(t);
  const body = JSON.stringify({ event: 'x', data: { blob: 'a'.repeat(1_100_000) } });
  const r = await postLogs(app.port, WRITE_KEY, body, {
    'content-length': String(Buffer.byteLength(body)),
  });
  assert.equal(r.status, 413);
  assert.equal(app.walWriter.appended.length, 0);
});

// Budget must be enforced at ADMISSION time, not after the serialized append
// resolves. The real writer bumps totalBytes() only after fh.write() completes
// (src/wal/writer.js), so when many requests are admitted concurrently and their
// appends are still in flight, overBudget() reads stale (0) and every request
// sails past the 429 gate — the on-disk WAL then overshoots budgetBytes by
// roughly (concurrent in-flight) x (per-request bytes). PRD §7.3 promises a 429
// "rather than risking the disk"; contract C5 ties the gate to budgetBytes.
// Repro: gate the writer so every admitted append stays in flight, fire a burst,
// and prove the server stops admitting once total + reserved-in-flight >= budget.
test('WAL budget is enforced at admission: concurrent in-flight appends cannot overshoot', async (t) => {
  const budgetMb = 0.02; // 0.02 MB = 20971 bytes
  const budgetBytes = Math.floor(budgetMb * 1024 * 1024);
  const walWriter = makeGatedWalWriter(budgetBytes);
  const app = await makeApp(t, { walWriter, budgetMb });

  // ~2 KB events so the declared content-length closely tracks the enriched
  // on-disk size (enrichment overhead is a small % of the payload, mirroring the
  // PRD's realistic large-body case). ~10 fit the budget.
  const blob = 'x'.repeat(2000);
  const N = 60; // far more than the budget can hold
  const settled = new Map(); // index -> status code (only requests that responded)
  const promises = [];
  for (let i = 0; i < N; i++) {
    // Honest sender: declare content-length so the admission gate can reserve the
    // payload up front (PRD §6.1 / the 413 path both assume declared sizes). This
    // is the worst case for the budget — a burst of concurrent declared writes.
    const body = JSON.stringify({ event: 'e', data: { i, blob } });
    const p = postLogs(app.port, WRITE_KEY, body, {
      'content-length': String(Buffer.byteLength(body)),
    }).then((r) => {
      settled.set(i, r.status);
      return r;
    });
    promises.push(p);
  }

  let admitted, rejected, perReq;
  try {
    // Quiesce: every request is now either append-pending (held in the gated
    // writer, awaiting release) or already answered 429. 202s cannot arrive until
    // we release, so settled-now responses are all 429s.
    const deadline = Date.now() + 5000;
    while (walWriter.held() + settled.size < N) {
      if (Date.now() > deadline) {
        throw new Error(`stuck: held=${walWriter.held()} settled=${settled.size} of ${N}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    // Let any last in-flight 429s flush through before we measure.
    await new Promise((r) => setTimeout(r, 50));

    admitted = walWriter.held(); // requests that passed the gate and reserved
    rejected = [...settled.values()].filter((s) => s === 429).length;
    perReq = walWriter.bytesPerAppend[0] ?? 1;

    // Pre-fix: total stays 0 while appends are in flight and nothing reserves, so
    // ALL N requests are admitted and rejected === 0. This assertion fails then.
    assert.ok(rejected > 0, `expected some 429s once budget is reserved, got 0 (admitted ${admitted})`);
    assert.ok(admitted < N, `expected the gate to stop admitting before all ${N} (admitted ${admitted})`);

    // The bytes the server has committed to writing must stay near the budget.
    // Pre-fix this is N*perReq (~6x budget here); the fix bounds it to roughly
    // budget plus the enrichment overhead of the admitted set plus one straddling
    // request. 1.5x is comfortably below the multi-x pre-fix overshoot.
    const onDiskBytes = admitted * perReq;
    assert.ok(
      onDiskBytes <= budgetBytes * 1.5,
      `admission overshoot: committed ${onDiskBytes}B vs budget ${budgetBytes}B (${(onDiskBytes / budgetBytes).toFixed(2)}x), admitted ${admitted}`,
    );
  } finally {
    // Always drain the held appends so the pending 202 requests resolve and the
    // server can shut down, even if an assertion above failed.
    walWriter.releaseAll();
  }

  const results = await Promise.all(promises);
  const accepted = results.filter((r) => r.status === 202).length;
  assert.equal(accepted, admitted, 'every admitted request should ack 202 after release');
  assert.equal(accepted + rejected, N, 'every request is either accepted or 429');
});

// Once the in-flight appends drain and totalBytes() reflects them, the reserved
// counter must be back to zero so capacity that actually freed up is usable
// again (no permanent under-counting / leaked reservations).
test('WAL budget reservation is released after each append resolves', async (t) => {
  const budgetMb = 0.02;
  const budgetBytes = Math.floor(budgetMb * 1024 * 1024);
  const walWriter = makeGatedWalWriter(budgetBytes);
  const app = await makeApp(t, { walWriter, budgetMb });

  // One request, released immediately: total advances by its bytes, reservation
  // returns to zero. A second request must still be admitted (budget has room).
  const first = postLogs(app.port, WRITE_KEY, { event: 'e' });
  const deadline = Date.now() + 5000;
  while (walWriter.held() < 1) {
    if (Date.now() > deadline) throw new Error('first append never reached the writer');
    await new Promise((r) => setTimeout(r, 5));
  }
  walWriter.releaseAll();
  assert.equal((await first).status, 202);

  assert.ok(walWriter.totalBytes() > 0 && walWriter.totalBytes() < budgetBytes);

  // With the reservation released, there is room for more; admit one more and
  // confirm it is not spuriously 429'd by a leaked/never-released reservation.
  const second = postLogs(app.port, WRITE_KEY, { event: 'e2' });
  while (walWriter.held() < 1) {
    if (Date.now() > deadline) throw new Error('second append never reached the writer');
    await new Promise((r) => setTimeout(r, 5));
  }
  walWriter.releaseAll();
  assert.equal((await second).status, 202);
  // totalBytes() reflects exactly the two persisted appends — no residual reserve.
  const persisted = walWriter.bytesPerAppend.reduce((a, b) => a + b, 0);
  assert.equal(walWriter.totalBytes(), persisted);
});

// Regression guard for the declared-oversize flake: an honest client that
// declares an oversize content-length must ALWAYS be able to read the clean 413
// the server promises (USAGE.md / contract C11). The old path forced the socket
// closed mid-upload (connection: close + req.resume()), so the in-flight ~1.1 MB
// body got RST and the client saw ECONNRESET on the request ~5-10% of the time
// instead of a readable 413. One request flakes rarely; a tight loop surfaces it.
test('declared body > 1 MB delivers a readable 413 every time (no ECONNRESET)', async (t) => {
  const app = await makeApp(t);
  const body = JSON.stringify({ event: 'x', data: { blob: 'a'.repeat(1_100_000) } });
  const headers = { 'content-length': String(Buffer.byteLength(body)) };
  for (let i = 0; i < 80; i++) {
    const r = await postLogs(app.port, WRITE_KEY, body, headers);
    assert.equal(r.status, 413, `iteration ${i} expected a readable 413`);
  }
  assert.equal(app.walWriter.appended.length, 0);
});

test('POST /v1/logs with undeclared (chunked) body > 1 MB is rejected', async (t) => {
  const app = await makeApp(t);
  // no content-length -> chunked; server destroys the request mid-body
  const body = JSON.stringify({ event: 'x', data: { blob: 'a'.repeat(1_100_000) } });
  await assert.rejects(postLogs(app.port, WRITE_KEY, body));
  assert.equal(app.walWriter.appended.length, 0);
});

// --- POST /v1/logs: validation ----------------------------------------------

test('POST /v1/logs with invalid JSON is 400', async (t) => {
  const app = await makeApp(t);
  const r = await postLogs(app.port, WRITE_KEY, 'this is not json{');
  assert.equal(r.status, 400);
  assert.equal(typeof jsonOf(r).error, 'string');
});

test('POST /v1/logs rejects the batch with the index of the first bad event', async (t) => {
  const app = await makeApp(t);
  const r = await postLogs(app.port, WRITE_KEY, [{ event: 'ok' }, { event: '' }, { event: 'ok2' }]);
  assert.equal(r.status, 400);
  const body = jsonOf(r);
  assert.equal(body.index, 1);
  assert.equal(typeof body.error, 'string');
  assert.equal(app.walWriter.appended.length, 0);
});

test('POST /v1/logs single invalid object reports index 0', async (t) => {
  const app = await makeApp(t);
  const r = await postLogs(app.port, WRITE_KEY, { event: 123 });
  assert.equal(r.status, 400);
  assert.equal(jsonOf(r).index, 0);
});

test('app/env are never trusted from the body (unknown top-level key is 400)', async (t) => {
  const app = await makeApp(t);
  const r = await postLogs(app.port, WRITE_KEY, { event: 'x', app: 'evil' });
  assert.equal(r.status, 400);
});

test('POST /v1/logs with an empty array is 400', async (t) => {
  const app = await makeApp(t);
  const r = await postLogs(app.port, WRITE_KEY, []);
  assert.equal(r.status, 400);
  assert.equal(jsonOf(r).index, undefined);
});

test('POST /v1/logs with more than 500 events is 413', async (t) => {
  const app = await makeApp(t);
  const r = await postLogs(app.port, WRITE_KEY, Array.from({ length: 501 }, () => ({ event: 'e' })));
  assert.equal(r.status, 413);
  assert.equal(app.walWriter.appended.length, 0);
});

// --- POST /v1/logs: accept path ----------------------------------------------

test('valid single event is enriched, appended to the WAL, and acked 202', async (t) => {
  const app = await makeApp(t);
  const r = await postLogs(app.port, WRITE_KEY, {
    event: 'ai.request',
    ids: { taskId: 't1' },
    data: { latencyMs: 42 },
  });
  assert.equal(r.status, 202);
  assert.deepEqual(jsonOf(r), { accepted: 1 });

  assert.equal(app.walWriter.appended.length, 1);
  const [docs] = app.walWriter.appended;
  assert.equal(docs.length, 1);
  const doc = docs[0];
  assert.match(doc._id, /^[0-9a-f]{32}$/);
  assert.equal(doc.app, 'appA'); // derived from the key, not the body
  assert.equal(doc.env, 'prod');
  assert.equal(doc.event, 'ai.request');
  assert.equal(doc.level, 'info');
  assert.deepEqual(doc.ids, { taskId: 't1' });
  assert.deepEqual(doc.data, { latencyMs: 42 });
  assert.equal(doc.receivedAt, FIXED_ISO);
  assert.equal(doc.expiresAt, '2026-07-11T12:00:00.000Z'); // info => +30 days
});

test('a batch is acked with its full count', async (t) => {
  const app = await makeApp(t);
  const r = await postLogs(app.port, WRITE_KEY, [
    { event: 'a' },
    { event: 'b', level: 'error' },
    { event: 'c' },
  ]);
  assert.equal(r.status, 202);
  assert.deepEqual(jsonOf(r), { accepted: 3 });
  const [docs] = app.walWriter.appended;
  assert.equal(docs.length, 3);
  assert.equal(docs[1].level, 'error');
  assert.equal(docs[1].expiresAt, '2026-09-09T12:00:00.000Z'); // error => +90 days
});

test('seq increments across requests and within a batch (identical events get distinct _ids)', async (t) => {
  const app = await makeApp(t); // fixed now() => receivedAt identical everywhere
  await postLogs(app.port, WRITE_KEY, [{ event: 'same' }, { event: 'same' }]);
  await postLogs(app.port, WRITE_KEY, { event: 'same' });
  const ids = app.walWriter.appended.flat().map((d) => d._id);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, `expected 3 distinct _ids, got ${ids}`);
  const isoSet = new Set(app.walWriter.appended.flat().map((d) => d.receivedAt));
  assert.deepEqual([...isoSet], [FIXED_ISO]); // one timestamp per request, same fixed clock
});

// --- GET /v1/logs -------------------------------------------------------------

function seededCollection() {
  const collection = createFakeCollection();
  const mk = (i, over = {}) => ({
    _id: `id-${String(i).padStart(2, '0')}`,
    app: 'appA',
    env: 'prod',
    event: 'ai.request',
    level: 'info',
    receivedAt: new Date(Date.UTC(2026, 5, 11, 1, 0, i)),
    expiresAt: new Date(Date.UTC(2026, 6, 11, 1, 0, i)),
    ...over,
  });
  collection.docs.push(
    mk(1, { data: { latencyMs: 10, status: 200, costUsd: 0.25 } }),
    mk(2, { level: 'error', data: { latencyMs: 50, status: 500 } }),
    mk(3, { app: 'appB', event: 'db.query', receivedAt: new Date(Date.UTC(2026, 5, 11, 2, 0, 3)) }),
    mk(4, { event: 'cron.run', message: 'nightly tidy' }),
    mk(5, { data: { latencyMs: 30, status: 200, costUsd: 0.5 } }),
  );
  return collection;
}

test('GET /v1/logs requires a key (401)', async (t) => {
  const app = await makeApp(t, { collection: seededCollection() });
  const r = await req(app.port, 'GET', '/v1/logs');
  assert.equal(r.status, 401);
});

test('GET /v1/logs without Mongo is 503 storage unavailable', async (t) => {
  const app = await makeApp(t);
  const r = await req(app.port, 'GET', '/v1/logs', { headers: auth(READ_KEY) });
  assert.equal(r.status, 503);
  assert.deepEqual(jsonOf(r), { error: 'storage unavailable' });
});

test('GET /v1/logs with an unknown parameter is 400', async (t) => {
  const app = await makeApp(t, { collection: seededCollection() });
  const r = await req(app.port, 'GET', '/v1/logs?bogus=1', { headers: auth(READ_KEY) });
  assert.equal(r.status, 400);
  assert.equal(typeof jsonOf(r).error, 'string');
});

test('GET /v1/logs returns items newest-first with ISO dates (read and write keys)', async (t) => {
  const app = await makeApp(t, { collection: seededCollection() });
  for (const key of [READ_KEY, WRITE_KEY]) {
    const r = await req(app.port, 'GET', '/v1/logs', { headers: auth(key) });
    assert.equal(r.status, 200);
    const body = jsonOf(r);
    assert.equal(body.items.length, 5);
    assert.equal(body.nextCursor, null);
    assert.deepEqual(
      body.items.map((d) => d._id),
      ['id-03', 'id-05', 'id-04', 'id-02', 'id-01'],
    );
    assert.equal(body.items[0].receivedAt, '2026-06-11T02:00:03.000Z'); // serialized ISO string
  }
});

test('GET /v1/logs applies filters and keyset pagination over HTTP', async (t) => {
  const app = await makeApp(t, { collection: seededCollection() });
  const h = { headers: auth(READ_KEY) };

  const errs = jsonOf(await req(app.port, 'GET', '/v1/logs?level=error', h));
  assert.deepEqual(errs.items.map((d) => d._id), ['id-02']);

  const appB = jsonOf(await req(app.port, 'GET', '/v1/logs?app=appB', h));
  assert.deepEqual(appB.items.map((d) => d._id), ['id-03']);

  const slow = jsonOf(await req(app.port, 'GET', '/v1/logs?data.latencyMs__gte=30', h));
  assert.deepEqual(slow.items.map((d) => d._id), ['id-05', 'id-02']);

  const page1 = jsonOf(await req(app.port, 'GET', '/v1/logs?limit=2', h));
  assert.equal(page1.items.length, 2);
  assert.notEqual(page1.nextCursor, null);
  const page2 = jsonOf(
    await req(app.port, 'GET', `/v1/logs?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`, h),
  );
  assert.deepEqual(page2.items.map((d) => d._id), ['id-04', 'id-02']);
});

// --- GET /v1/stats -------------------------------------------------------------

test('GET /v1/stats: 401 / 503 / 400 / 200 with bucket rollups', async (t) => {
  const noMongo = await makeApp(t);
  assert.equal((await req(noMongo.port, 'GET', '/v1/stats')).status, 401);
  assert.equal((await req(noMongo.port, 'GET', '/v1/stats', { headers: auth(READ_KEY) })).status, 503);

  const app = await makeApp(t, { collection: seededCollection() });
  const bad = await req(app.port, 'GET', '/v1/stats?group=minute', { headers: auth(READ_KEY) });
  assert.equal(bad.status, 400);

  const range = 'from=2026-06-11T00:00:00.000Z&to=2026-06-12T00:00:00.000Z';
  const r = await req(app.port, 'GET', `/v1/stats?group=hour&${range}`, { headers: auth(READ_KEY) });
  assert.equal(r.status, 200);
  const body = jsonOf(r);
  assert.equal(body.group, 'hour');
  assert.equal(body.from, '2026-06-11T00:00:00.000Z');
  assert.equal(body.to, '2026-06-12T00:00:00.000Z');
  assert.equal(body.buckets.length, 2);
  const [h1, h2] = body.buckets;
  assert.equal(h1.bucket, '2026-06-11T01:00:00.000Z');
  assert.equal(h1.total, 4);
  assert.deepEqual(h1.counts, { debug: 0, info: 3, warn: 0, error: 1 });
  assert.equal(h1.errorRate, 1 / 3); // status-bearing docs only: 200,500,200
  assert.equal(h1.costUsd, 0.75);
  assert.equal(h1.latency.p50, 30);
  assert.equal(h2.total, 1);
  assert.equal(h2.latency, null);
  assert.equal(h2.errorRate, null);
});

// --- GET /v1/events -------------------------------------------------------------

test('GET /v1/events: 401 / 503 / 200 with per-app sorted event names', async (t) => {
  const noMongo = await makeApp(t);
  assert.equal((await req(noMongo.port, 'GET', '/v1/events')).status, 401);
  assert.equal(
    (await req(noMongo.port, 'GET', '/v1/events', { headers: auth(READ_KEY) })).status,
    503,
  );

  const app = await makeApp(t, { collection: seededCollection() });
  const all = jsonOf(await req(app.port, 'GET', '/v1/events', { headers: auth(READ_KEY) }));
  assert.deepEqual(all, { apps: { appA: ['ai.request', 'cron.run'], appB: ['db.query'] } });

  const onlyB = jsonOf(
    await req(app.port, 'GET', '/v1/events?app=appB', { headers: auth(READ_KEY) }),
  );
  assert.deepEqual(onlyB, { apps: { appB: ['db.query'] } });

  const none = jsonOf(
    await req(app.port, 'GET', '/v1/events?app=ghost', { headers: auth(READ_KEY) }),
  );
  assert.deepEqual(none, { apps: {} });
});

test('GET /v1/events rejects unknown query params with 400 (parity with logs/stats)', async (t) => {
  const app = await makeApp(t, { collection: seededCollection() });
  const r = await req(app.port, 'GET', '/v1/events?bogus=1', { headers: auth(READ_KEY) });
  assert.equal(r.status, 400);
  assert.match(jsonOf(r).error, /unknown parameter: bogus/);
});

test('GET /healthz sanitizes flusher.lastError to a category (no path/secret leak)', async (t) => {
  // A realistic raw flusher error leaking a WAL path + Mongo namespace + URI host.
  const leaky =
    'MongoServerError: connection refused to mongodb+srv://admin:s3cr3t@cluster0.abc.mongodb.net writing C:/data/wal/seg-0000000000007.ndjson into appLogs.events';
  const flusher = {
    started: false,
    stopped: false,
    start() {},
    stop: async () => {},
    status: () => ({ running: true, caughtUp: false, lastError: leaky, flushedTotal: 0 }),
  };
  const app = await makeApp(t, { flusher });
  const body = jsonOf(await req(app.port, 'GET', '/healthz'));
  assert.equal(body.flusher.lastError, 'storage unreachable');
  // The raw string's secrets must not appear anywhere in the response.
  const raw = JSON.stringify(body);
  for (const leak of ['s3cr3t', 'mongodb.net', 'appLogs.events', 'seg-0000000000007', 'C:/data/wal']) {
    assert.equal(raw.includes(leak), false, `healthz leaked: ${leak}`);
  }
});

// --- UI + 404 ---------------------------------------------------------------------

test('GET / serves the static UI without auth', async (t) => {
  const app = await makeApp(t);
  const r = await req(app.port, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/html/);
  const uiFile = readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
  assert.equal(r.text, uiFile);
});

test('unknown routes and methods are 404 {error:"not found"}', async (t) => {
  const app = await makeApp(t);
  for (const [method, path] of [
    ['GET', '/nope'],
    ['POST', '/healthz'],
    ['GET', '/v1/logs/'],
    ['DELETE', '/v1/logs'],
  ]) {
    const r = await req(app.port, method, path);
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.deepEqual(jsonOf(r), { error: 'not found' });
  }
});

// --- shutdown -----------------------------------------------------------------------

test('shutdown() closes the server, stops the flusher, and closes the WAL writer', async (t) => {
  const app = await makeApp(t);
  await app.shutdown();
  assert.equal(app.server.listening, false);
  assert.equal(app.flusher.stopped, true);
  assert.equal(app.walWriter.closed, true);
  await app.shutdown(); // idempotent: t.after will call it again anyway
});

test('shutdown() works on a never-listened app', async () => {
  const walDir = await mkTmpDir('timber-server-noListen-');
  const config = loadConfig({
    TIMBER_WAL_DIR: walDir,
    TIMBER_KEYS: JSON.stringify([{ key: WRITE_KEY, app: 'appA', env: 'prod', mode: 'write' }]),
  });
  const walWriter = makeFakeWalWriter();
  const flusher = makeFakeFlusher();
  const { server, shutdown } = buildApp(config, {
    keyring: createKeyring(config.keys),
    walWriter,
    flusher,
    getCollection: () => null,
    now: () => new Date(),
  });
  assert.equal(server.listening, false);
  await shutdown();
  assert.equal(flusher.stopped, true);
  assert.equal(walWriter.closed, true);
  await rmTmpDir(walDir);
});
