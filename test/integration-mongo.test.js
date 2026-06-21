// Task 16 — the e2e scenario against a real MongoDB (and the only test allowed
// to touch the network, contract C14). Gated on TIMBER_TEST_MONGODB_URI:
// without it every test skips itself cleanly. Uses db appLogs_test_<pid>,
// dropped afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { loadConfig } from '../src/config.js';
import { createKeyring } from '../src/auth.js';
import { createWalWriter } from '../src/wal/writer.js';
import { createFlusher } from '../src/flusher.js';
import { connectMongo, ensureIndexes } from '../src/mongo.js';
import { buildApp } from '../src/server.js';
import { mkTmpDir, rmTmpDir } from './helpers/tmp.js';

const URI = process.env.TIMBER_TEST_MONGODB_URI;
const DB_NAME = `appLogs_test_${process.pid}`;
// PRD section 9 bar is 500 ms for a filtered hour window; overridable for runs
// against a far-away cluster.
const QUERY_BUDGET_MS = Number(process.env.TIMBER_TEST_QUERY_BUDGET_MS || 500);

const KEY_A = 'int-write-key-appA-0123456789abcd';
const KEY_B = 'int-write-key-appB-0123456789abcd';
const READ_KEY = 'int-read-key-0123456789abcdef0123';
const RUN_ID = `int-run-${process.pid}`;
const BASE_ISO = '2026-06-11T10:00:00.000Z';
const BASE_MS = Date.parse(BASE_ISO);
const TOTAL = 250;
const BATCH_SIZES = [1, 2, 5, 10, 25, 50, 100, 57]; // sum 250; last batch ingests as appB

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
  return { port: server.address().port, shutdown };
}

async function pollHealthz(port, predicate, what, timeoutMs = 30000) {
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

test('integration: full stack against real MongoDB (WAL -> flusher -> query -> replay)', async (t) => {
  if (!URI) {
    t.skip('TIMBER_TEST_MONGODB_URI not set');
    return;
  }

  const { client, collection } = await connectMongo(URI, {
    dbName: DB_NAME,
    collectionName: 'events',
  });
  t.after(async () => {
    try {
      await client.db(DB_NAME).dropDatabase();
    } finally {
      await client.close();
    }
  });

  const walDir = await mkTmpDir('timber-int-');
  t.after(async () => {
    await rmTmpDir(walDir);
  });

  await t.test('ensureIndexes creates the C7 set; TTL on expiresAt visible via listIndexes', async () => {
    await ensureIndexes(collection);
    await ensureIndexes(collection); // idempotent

    const indexes = await collection.listIndexes().toArray();
    const byName = new Map(indexes.map((ix) => [ix.name, ix]));
    assert.equal(indexes.length, 8, `expected _id_ + 7 C7 indexes, got ${[...byName.keys()]}`);

    assert.deepEqual(byName.get('receivedAt_-1')?.key, { receivedAt: -1 });
    assert.deepEqual(byName.get('app_1_receivedAt_-1')?.key, { app: 1, receivedAt: -1 });
    assert.deepEqual(byName.get('event_1_receivedAt_-1')?.key, { event: 1, receivedAt: -1 });
    assert.deepEqual(byName.get('level_1_receivedAt_-1')?.key, { level: 1, receivedAt: -1 });
    assert.equal(byName.get('ids.requestId_1')?.sparse, true);
    assert.equal(byName.get('ids.taskId_1')?.sparse, true);

    const ttl = byName.get('expiresAt_1');
    assert.ok(ttl, 'TTL index on expiresAt must exist');
    assert.equal(ttl.expireAfterSeconds, 0);
  });

  const stack1 = await buildStack(walDir, collection);
  let stack1Down = false;
  t.after(async () => {
    if (!stack1Down) await stack1.shutdown();
  });

  await t.test('250 mixed-batch events ack 202 and drain into Mongo exactly once', async () => {
    let n = 0;
    for (let b = 0; b < BATCH_SIZES.length; b++) {
      const size = BATCH_SIZES[b];
      const events = Array.from({ length: size }, () => eventFor(n++));
      const payload = size === 1 ? events[0] : events;
      const r = await req(stack1.port, 'POST', '/v1/logs', {
        headers: {
          'content-type': 'application/json',
          ...auth(b === BATCH_SIZES.length - 1 ? KEY_B : KEY_A),
        },
        body: JSON.stringify(payload),
      });
      assert.equal(r.status, 202, `batch ${b}: ${r.text}`);
      assert.deepEqual(jsonOf(r), { accepted: size });
    }

    const h = await pollHealthz(
      stack1.port,
      (x) => x.flusher.caughtUp && x.flusher.flushedTotal >= TOTAL,
      'flusher to drain into Mongo',
    );
    assert.equal(h.mongo.connected, true);
    assert.equal(h.wal.backlogBytes, 0);

    assert.equal(await collection.countDocuments({ 'ids.runId': RUN_ID }), TOTAL);
    const ids = await collection.distinct('_id', { 'ids.runId': RUN_ID });
    assert.equal(ids.length, TOTAL, 'distinct _ids == doc count (no dupes)');

    // BSON Dates survived the WAL ISO round-trip (TTL + $dateTrunc depend on it)
    const sample = await collection.findOne({ 'ids.n': '42' });
    assert.ok(sample.receivedAt instanceof Date);
    assert.ok(sample.expiresAt instanceof Date);
    assert.equal(sample.app, 'appA');
  });

  await t.test('filtered queries + keyset pagination over HTTP against real Mongo', async () => {
    const errors = await getJson(stack1.port, '/v1/logs?level=error');
    assert.equal(errors.items.length, 25);

    const appB = await getJson(stack1.port, '/v1/logs?app=appB');
    assert.equal(appB.items.length, 57);

    const ai = await getJson(stack1.port, '/v1/logs?event=ai.');
    assert.equal(ai.items.length, 84);
    assert.ok(ai.items.every((d) => d.event === 'ai.request'));

    const slow = await getJson(stack1.port, '/v1/logs?data.latencyMs__gte=240');
    assert.equal(slow.items.length, 10);

    const one = await getJson(stack1.port, '/v1/logs?ids.n=42');
    assert.equal(one.items.length, 1);
    assert.equal(one.items[0].message, 'event number 42');
    assert.equal(typeof one.items[0].receivedAt, 'string'); // ISO on the wire

    // PRD section 9: filtered last-hour window <= 500 ms (soft bar, env-tunable)
    const from = encodeURIComponent(BASE_ISO);
    const to = encodeURIComponent('2026-06-11T11:00:00.000Z');
    const started = performance.now();
    const firstPage = await getJson(stack1.port, `/v1/logs?from=${from}&to=${to}&limit=100`);
    const elapsedMs = performance.now() - started;
    t.diagnostic(`filtered hour query took ${elapsedMs.toFixed(1)} ms (budget ${QUERY_BUDGET_MS})`);
    assert.ok(
      elapsedMs <= QUERY_BUDGET_MS,
      `filtered hour query took ${elapsedMs.toFixed(1)} ms > ${QUERY_BUDGET_MS} ms`,
    );

    // full keyset walk: 100+100+50, no overlap, no gap
    const seen = new Set(firstPage.items.map((d) => d._id));
    let cursor = firstPage.nextCursor;
    let pages = 1;
    while (cursor !== null) {
      const page = await getJson(
        stack1.port,
        `/v1/logs?from=${from}&to=${to}&limit=100&cursor=${encodeURIComponent(cursor)}`,
      );
      for (const item of page.items) seen.add(item._id);
      cursor = page.nextCursor;
      pages++;
      assert.ok(pages <= 10, 'pagination did not terminate');
    }
    assert.equal(pages, 3);
    assert.equal(seen.size, TOTAL);
  });

  await t.test('real $percentile stats run: exact counts, approximate latency', async () => {
    const body = await getJson(
      stack1.port,
      '/v1/stats?group=hour&from=2026-06-11T10:00:00.000Z&to=2026-06-11T11:00:00.000Z',
    );
    assert.equal(body.buckets.length, 1);
    const b = body.buckets[0];
    assert.equal(b.bucket, BASE_ISO);
    assert.equal(b.total, TOTAL);
    assert.deepEqual(b.counts, { debug: 0, info: 200, warn: 25, error: 25 });
    assert.equal(b.errorRate, 0.1);
    assert.equal(b.costUsd, 2.5);
    assert.equal(b.inputTokens, 840);
    assert.equal(b.outputTokens, 420);
    // latencyMs is uniform 0..249; $percentile method:'approximate' (t-digest)
    // is near-exact at n=250 — assert sane windows, not exact ranks.
    assert.ok(b.latency, 'latency rollup must be present');
    const { p50, p95, p99 } = b.latency;
    assert.ok(p50 >= 110 && p50 <= 140, `p50 ${p50}`);
    assert.ok(p95 >= 225 && p95 <= 248, `p95 ${p95}`);
    assert.ok(p99 >= 235 && p99 <= 249, `p99 ${p99}`);
    assert.ok(p50 <= p95 && p95 <= p99, 'percentiles must be monotone');
  });

  await t.test('events listing groups per app', async () => {
    const all = await getJson(stack1.port, '/v1/events');
    assert.deepEqual(all, {
      apps: {
        appA: ['ai.request', 'cron.run', 'db.query'],
        appB: ['ai.request', 'cron.run', 'db.query'],
      },
    });
  });

  // A small dedicated batch (NO runId, so it never disturbs the RUN_ID count the
  // replay subtest re-checks) with per-user emails and explicit levels, so the
  // real $facet/$objectToArray facets pipeline and the groupby aggregation can be
  // asserted against a known distribution.
  const GB_GROUP = 'gb';
  await t.test('facets discovers seeded ids/data keys against real Mongo', async () => {
    const batch = [
      { event: 'ai.request', level: 'error', ids: { userEmail: 'alice@e.com', grp: GB_GROUP }, data: { latencyMs: 12, model: 'opus' } },
      { event: 'ai.request', level: 'error', ids: { userEmail: 'alice@e.com', grp: GB_GROUP }, data: { latencyMs: 20, model: 'opus' } },
      { event: 'ai.request', level: 'error', ids: { userEmail: 'alan@e.com', grp: GB_GROUP }, data: { latencyMs: 33 } },
      { event: 'ai.request', level: 'info', ids: { userEmail: 'bob@e.com', grp: GB_GROUP }, data: { latencyMs: 5 } },
    ];
    const r = await req(stack1.port, 'POST', '/v1/logs', {
      headers: { 'content-type': 'application/json', ...auth(KEY_A) },
      body: JSON.stringify(batch),
    });
    assert.equal(r.status, 202, r.text);

    // Wait for the whole WAL (the original 250 + this batch) to drain.
    await pollHealthz(
      stack1.port,
      (x) => x.flusher.caughtUp && x.flusher.flushedTotal >= TOTAL + batch.length,
      'groupby batch to drain',
    );

    // Wide window covering every ingested doc (server clock starts at BASE_ISO).
    const win = `from=${encodeURIComponent(BASE_ISO)}&to=${encodeURIComponent('2026-06-11T12:00:00.000Z')}`;
    const facets = await getJson(stack1.port, `/v1/facets?app=appA&${win}`);
    // appA docs carry ids {runId,n} (the 250 seed) plus {userEmail,grp} (this batch).
    for (const k of ['runId', 'n', 'userEmail', 'grp']) {
      assert.ok(facets.idsKeys.includes(k), `idsKeys missing ${k}: ${facets.idsKeys}`);
    }
    assert.deepEqual(facets.idsKeys, facets.idsKeys.slice().sort(), 'idsKeys must be sorted');
    for (const p of ['latencyMs', 'status', 'costUsd', 'model']) {
      assert.ok(facets.dataPaths.includes(p), `dataPaths missing ${p}: ${facets.dataPaths}`);
    }
    assert.deepEqual(facets.window, { from: BASE_ISO, to: '2026-06-11T12:00:00.000Z' });
  });

  await t.test('groupby by ids.userEmail with level=error counts correctly; like filters values', async () => {
    const win = `from=${encodeURIComponent(BASE_ISO)}&to=${encodeURIComponent('2026-06-11T12:00:00.000Z')}`;
    // Scope to this batch via ids.grp so the 250-doc seed (which has no userEmail)
    // doesn't add a null-keyed group; level=error keeps alice x2 and alan x1.
    const gb = await getJson(
      stack1.port,
      `/v1/groupby?by=ids.userEmail&level=error&ids.grp=${GB_GROUP}&${win}`,
    );
    assert.equal(gb.by, 'ids.userEmail');
    assert.equal(gb.total, 3); // alice(2) + alan(1); bob is level=info, excluded
    assert.deepEqual(gb.groups, [
      { value: 'alice@e.com', count: 2 },
      { value: 'alan@e.com', count: 1 },
    ]);
    assert.equal(gb.otherCount, 0);

    // like='al' is a case-insensitive regex over the grouped values: alice + alan.
    const liked = await getJson(
      stack1.port,
      `/v1/groupby?by=ids.userEmail&level=error&ids.grp=${GB_GROUP}&like=al&${win}`,
    );
    assert.deepEqual(
      liked.groups.map((g) => g.value).sort(),
      ['alan@e.com', 'alice@e.com'],
    );
    assert.equal(liked.total, 3);

    // limit collapses the tail into otherCount.
    const limited = await getJson(
      stack1.port,
      `/v1/groupby?by=ids.userEmail&level=error&ids.grp=${GB_GROUP}&limit=1&${win}`,
    );
    assert.deepEqual(limited.groups, [{ value: 'alice@e.com', count: 2 }]);
    assert.equal(limited.otherCount, 1); // alan
  });

  await t.test('checkpoint-reset replay is idempotent against real Mongo (E11000 path)', async () => {
    await stack1.shutdown();
    stack1Down = true;

    // Crash-before-checkpoint simulation: replay the whole WAL into a
    // collection that already holds every doc. The real MongoBulkWriteError
    // (all writeErrors code 11000) must be treated as success.
    await unlink(join(walDir, 'checkpoint.json'));
    const flusher = createFlusher({
      walDir,
      getCollection: () => collection,
      batchSize: 100,
      intervalMs: 10,
    });
    flusher.start();
    try {
      const deadline = Date.now() + 30000;
      while (!(flusher.status().caughtUp && flusher.status().flushedTotal >= TOTAL)) {
        assert.ok(Date.now() < deadline, `replay stuck: ${JSON.stringify(flusher.status())}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      await flusher.stop();
    }
    assert.equal(flusher.status().lastError, null, 'pure-duplicate replay is not an error');
    assert.equal(
      await collection.countDocuments({ 'ids.runId': RUN_ID }),
      TOTAL,
      'replay upserted, not duplicated',
    );
  });
});
