// Task 16 — end-to-end over the full real stack: real WAL on disk (tmp dir),
// real flusher (real wal reader/checkpoint via its lazy default walOps), real
// node:http server and client. Only the Mongo collection is faked (C12 helper),
// injected through buildApp's deps — so this runs without Docker/network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { loadConfig } from '../src/config.js';
import { createKeyring } from '../src/auth.js';
import { createWalWriter } from '../src/wal/writer.js';
import { createFlusher } from '../src/flusher.js';
import { buildApp } from '../src/server.js';
import { createFakeCollection } from './helpers/fake-collection.js';
import { mkTmpDir, rmTmpDir } from './helpers/tmp.js';

const KEY_A = 'e2e-write-key-appA-0123456789abcd';
const KEY_B = 'e2e-write-key-appB-0123456789abcd';
const READ_KEY = 'e2e-read-key-0123456789abcdef0123';
const RUN_ID = 'e2e-replay-proof';
const BASE_ISO = '2026-06-11T10:00:00.000Z';
const BASE_MS = Date.parse(BASE_ISO);
const TOTAL = 250;
// Mixed batch sizes (sum 250); the first is sent as a bare object, the last
// goes in under appB's key so /v1/events has two apps to report.
const BATCH_SIZES = [1, 2, 5, 10, 25, 50, 100, 57];

// --- deterministic event factory --------------------------------------------
// n in 0..249. Levels: error when n%10==0 (25), warn when n%5==0 else (25),
// info otherwise (200). Events: ai.request (84) / db.query (83) / cron.run (83).
function eventFor(n) {
  const event = n % 3 === 0 ? 'ai.request' : n % 3 === 1 ? 'db.query' : 'cron.run';
  const level = n % 10 === 0 ? 'error' : n % 5 === 0 ? 'warn' : 'info';
  const data = { latencyMs: n, status: n % 10 === 0 ? 500 : 200, costUsd: 0.01 };
  if (event === 'ai.request') {
    data.inputTokens = 10;
    data.outputTokens = 5;
  }
  return { event, level, message: `event number ${n}`, ids: { runId: RUN_ID, n }, data };
}

// --- tiny HTTP client ---------------------------------------------------------
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

async function getJson(port, path, key = READ_KEY) {
  const r = await req(port, 'GET', path, { headers: auth(key) });
  assert.equal(r.status, 200, `GET ${path} -> ${r.status}: ${r.text}`);
  return jsonOf(r);
}

// --- stack assembly -------------------------------------------------------------
// Same wiring main() performs, but with an injected collection and a controlled
// clock: now() advances 1s per request so receivedAt is deterministic and every
// event lands inside the 10:00-11:00 UTC stats hour.
async function buildStack(walDir, collection) {
  const config = loadConfig({
    TIMBER_WAL_DIR: walDir,
    TIMBER_WAL_FSYNC_MS: '5',
    TIMBER_FLUSH_INTERVAL_MS: '20',
    TIMBER_FLUSH_BATCH: '100',
    TIMBER_KEYS: JSON.stringify([
      { key: KEY_A, app: 'appA', env: 'prod', mode: 'write' },
      { key: KEY_B, app: 'appB', env: 'prod', mode: 'write' },
      { key: READ_KEY, app: 'observer', env: 'prod', mode: 'read' },
    ]),
  });
  const walWriter = await createWalWriter({
    dir: config.walDir,
    fsyncMs: config.walFsyncMs,
    segmentMaxBytes: config.walSegmentMaxBytes,
    budgetBytes: config.walBudgetBytes,
    retainHours: config.walRetainHours,
  });
  const flusher = createFlusher({
    walDir: config.walDir,
    getCollection: () => collection,
    batchSize: config.flushBatchSize,
    intervalMs: config.flushIntervalMs,
  });
  let tick = 0;
  const { server, shutdown } = buildApp(config, {
    keyring: createKeyring(config.keys),
    walWriter,
    flusher,
    getCollection: () => collection,
    now: () => new Date(BASE_MS + 1000 * tick++),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  flusher.start();
  return { port: server.address().port, shutdown, flusher };
}

async function pollHealthz(port, predicate, what, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = jsonOf(await req(port, 'GET', '/healthz'));
    if (predicate(last)) return last;
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}; last healthz: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function assertNewestFirst(items) {
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    // toISOString output compares lexicographically == chronologically
    assert.ok(cur.receivedAt <= prev.receivedAt, `receivedAt out of order at index ${i}`);
    if (cur.receivedAt === prev.receivedAt) {
      assert.ok(cur._id < prev._id, `_id tiebreak out of order at index ${i}`);
    }
  }
}

async function paginate(port, baseQuery, limit) {
  const pages = [];
  let cursor = null;
  for (;;) {
    const sep = baseQuery.includes('?') ? '&' : '?';
    const cursorPart = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const body = await getJson(port, `${baseQuery}${sep}limit=${limit}${cursorPart}`);
    pages.push(body.items);
    if (body.nextCursor === null) return pages;
    cursor = body.nextCursor;
    assert.ok(pages.length <= 50, 'pagination did not terminate');
  }
}

// --- the scenario ------------------------------------------------------------------

test('e2e: ingest -> WAL -> flusher -> query/stats/events over real HTTP, then crash-replay', async (t) => {
  const walDir = await mkTmpDir('timber-e2e-');
  t.after(async () => {
    await rmTmpDir(walDir);
  });

  const collection = createFakeCollection();
  const stack1 = await buildStack(walDir, collection);
  let stack1Down = false;
  t.after(async () => {
    if (!stack1Down) await stack1.shutdown();
  });

  await t.test('250 events in mixed batches are all acked 202 with exact counts', async () => {
    let n = 0;
    for (let b = 0; b < BATCH_SIZES.length; b++) {
      const size = BATCH_SIZES[b];
      const events = Array.from({ length: size }, () => eventFor(n++));
      const isLastBatch = b === BATCH_SIZES.length - 1;
      const payload = size === 1 ? events[0] : events; // single object form per PRD section 6.1
      const r = await req(stack1.port, 'POST', '/v1/logs', {
        headers: { 'content-type': 'application/json', ...auth(isLastBatch ? KEY_B : KEY_A) },
        body: JSON.stringify(payload),
      });
      assert.equal(r.status, 202, `batch ${b}: ${r.text}`);
      assert.deepEqual(jsonOf(r), { accepted: size });
    }
    assert.equal(n, TOTAL);
  });

  await t.test('flusher drains the WAL into the collection; healthz reflects it', async () => {
    const h = await pollHealthz(
      stack1.port,
      (x) => x.flusher.caughtUp && x.flusher.flushedTotal >= TOTAL,
      'flusher to drain 250 events',
    );
    assert.equal(h.ok, true);
    assert.equal(h.mongo.connected, true);
    assert.equal(h.flusher.lastError, null);
    assert.equal(h.flusher.running, true);
    assert.equal(h.wal.backlogBytes, 0, 'checkpoint must have consumed every WAL byte');
    assert.equal(h.wal.overBudget, false);

    assert.equal(collection.docs.length, TOTAL);
    assert.equal(new Set(collection.docs.map((d) => d._id)).size, TOTAL, 'distinct _ids');
    for (const doc of collection.docs) {
      assert.ok(doc.receivedAt instanceof Date, 'flusher must revive receivedAt to Date');
      assert.ok(doc.expiresAt instanceof Date, 'flusher must revive expiresAt to Date');
    }
  });

  await t.test('GET /v1/logs: filters behave on the real pipeline output', async () => {
    const errors = await getJson(stack1.port, '/v1/logs?level=error');
    assert.equal(errors.items.length, 25);
    assert.deepEqual(
      new Set(errors.items.map((d) => d.ids.n)),
      new Set(Array.from({ length: 25 }, (_, i) => String(i * 10))),
    );

    const appB = await getJson(stack1.port, '/v1/logs?app=appB');
    assert.equal(appB.items.length, 57);
    assert.ok(appB.items.every((d) => d.app === 'appB' && d.env === 'prod'));

    const ai = await getJson(stack1.port, '/v1/logs?event=ai.');
    assert.equal(ai.items.length, 84);
    assert.ok(ai.items.every((d) => d.event === 'ai.request'));

    const slow = await getJson(stack1.port, '/v1/logs?data.latencyMs__gte=240');
    assert.equal(slow.items.length, 10);

    const band = await getJson(
      stack1.port,
      '/v1/logs?data.latencyMs__gte=100&data.latencyMs__lte=104',
    );
    assert.equal(band.items.length, 5);

    const status500 = await getJson(stack1.port, '/v1/logs?data.status=500');
    assert.equal(status500.items.length, 25);

    const one = await getJson(stack1.port, '/v1/logs?ids.n=42');
    assert.equal(one.items.length, 1);
    assert.equal(one.items[0].message, 'event number 42');
    assert.equal(typeof one.items[0].receivedAt, 'string'); // ISO over the wire
    assert.match(one.items[0].receivedAt, /^2026-06-11T10:00:0\d\.000Z$/);

    const q = await getJson(stack1.port, `/v1/logs?q=${encodeURIComponent('^event number 42$')}`);
    assert.equal(q.items.length, 1);
    assert.equal(q.items[0].ids.n, '42');

    // write keys may query too
    const viaWriteKey = await getJson(stack1.port, '/v1/logs?ids.n=42', KEY_A);
    assert.equal(viaWriteKey.items.length, 1);
  });

  await t.test('GET /v1/logs: keyset pagination covers all 250 exactly once, newest-first', async () => {
    const from = encodeURIComponent(BASE_ISO);
    const to = encodeURIComponent('2026-06-11T11:00:00.000Z');
    const pages = await paginate(stack1.port, `/v1/logs?from=${from}&to=${to}`, 100);
    assert.deepEqual(pages.map((p) => p.length), [100, 100, 50]);
    const all = pages.flat();
    assert.equal(new Set(all.map((d) => d._id)).size, TOTAL, 'no overlap, no gap');
    assertNewestFirst(all);
  });

  await t.test('GET /v1/stats: one hour bucket with exact convention rollups', async () => {
    const body = await getJson(
      stack1.port,
      '/v1/stats?group=hour&from=2026-06-11T10:00:00.000Z&to=2026-06-11T11:00:00.000Z',
    );
    assert.equal(body.group, 'hour');
    assert.equal(body.from, '2026-06-11T10:00:00.000Z');
    assert.equal(body.to, '2026-06-11T11:00:00.000Z');
    assert.equal(body.buckets.length, 1);
    const b = body.buckets[0];
    assert.equal(b.bucket, BASE_ISO);
    assert.equal(b.total, TOTAL);
    assert.deepEqual(b.counts, { debug: 0, info: 200, warn: 25, error: 25 });
    assert.equal(b.errorRate, 0.1); // 25 of 250 status-bearing docs are >= 400
    assert.equal(b.costUsd, 2.5); // 250 * 0.01, rounded to 6 dp
    assert.deepEqual(b.latency, { p50: 124, p95: 237, p99: 247 }); // nearest-rank over 0..249
    assert.equal(b.inputTokens, 840); // 84 ai.request * 10
    assert.equal(b.outputTokens, 420); // 84 ai.request * 5
  });

  await t.test('GET /v1/events lists distinct events per app', async () => {
    const all = await getJson(stack1.port, '/v1/events');
    assert.deepEqual(all, {
      apps: {
        appA: ['ai.request', 'cron.run', 'db.query'],
        appB: ['ai.request', 'cron.run', 'db.query'],
      },
    });
    const onlyA = await getJson(stack1.port, '/v1/events?app=appA');
    assert.deepEqual(Object.keys(onlyA.apps), ['appA']);
  });

  // --- restart simulation: same WAL dir, fresh collection -> full replay -------
  let replayIds;
  await t.test('replay after restart delivers everything exactly once', async () => {
    const idsRun1 = new Set(collection.docs.map((d) => d._id));
    await stack1.shutdown();
    stack1Down = true;

    // Simulate a crash before any flush was checkpointed: as far as the new
    // process knows, nothing ever reached Mongo.
    await unlink(join(walDir, 'checkpoint.json'));

    const collection2 = createFakeCollection();
    const stack2 = await buildStack(walDir, collection2);
    try {
      const h = await pollHealthz(
        stack2.port,
        (x) => x.flusher.caughtUp && x.flusher.flushedTotal >= TOTAL,
        'boot replay to drain',
      );
      assert.equal(h.flusher.lastError, null);
      assert.equal(collection2.docs.length, TOTAL, 'replay must deliver every accepted event');
      const idsRun2 = new Set(collection2.docs.map((d) => d._id));
      assert.equal(idsRun2.size, TOTAL, 'exactly once: no duplicate _ids');
      assert.deepEqual(idsRun2, idsRun1, 'replayed docs are the same docs (deterministic _ids)');
      replayIds = idsRun2;
    } finally {
      await stack2.shutdown();
    }
  });

  await t.test('double replay into a non-empty collection upserts, not duplicates', async () => {
    // Crash-between-insert-and-checkpoint case: the WAL replays into a
    // collection that already holds every doc. All-11000 must count as success.
    await unlink(join(walDir, 'checkpoint.json'));
    const collection3 = createFakeCollection();
    for (const id of replayIds) collection3.docs.push({ _id: id }); // pre-seed every _id
    const flusher = createFlusher({
      walDir,
      getCollection: () => collection3,
      batchSize: 100,
      intervalMs: 10,
    });
    flusher.start();
    try {
      const deadline = Date.now() + 20000;
      while (!(flusher.status().caughtUp && flusher.status().flushedTotal >= TOTAL)) {
        assert.ok(Date.now() < deadline, `flusher stuck: ${JSON.stringify(flusher.status())}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    } finally {
      await flusher.stop();
    }
    assert.equal(flusher.status().lastError, null, 'duplicate replay must not be an error');
    assert.equal(collection3.docs.length, TOTAL, 'no duplicates were inserted');
  });
});
