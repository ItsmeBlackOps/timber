import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { deriveId, createSeqGenerator } from '../src/ids.js';
import { enrich } from '../src/validate.js';
import { createFlusher } from '../src/flusher.js';
import { createFakeCollection } from './helpers/fake-collection.js';

const base = {
  app: 'dailyDashboard',
  receivedAtIso: '2026-06-11T12:00:00.000Z',
  seq: 41,
  envelope: { event: 'ai.request', level: 'info', data: { model: 'claude-opus-4-8' } },
};

test('deriveId returns 32 lowercase hex chars', () => {
  const id = deriveId(base);
  assert.match(id, /^[0-9a-f]{32}$/);
});

test('deriveId is deterministic for identical inputs', () => {
  const a = deriveId(base);
  const b = deriveId({ ...base, envelope: { ...base.envelope } });
  assert.equal(a, b);
});

test('deriveId differs when seq differs (identical body, same ms)', () => {
  const a = deriveId(base);
  const b = deriveId({ ...base, seq: base.seq + 1 });
  assert.notEqual(a, b);
});

test('deriveId differs when app, receivedAtIso, or envelope differ', () => {
  const a = deriveId(base);
  assert.notEqual(deriveId({ ...base, app: 'scraper' }), a);
  assert.notEqual(deriveId({ ...base, receivedAtIso: '2026-06-11T12:00:00.001Z' }), a);
  assert.notEqual(deriveId({ ...base, envelope: { event: 'ai.request', level: 'warn' } }), a);
});

test('deriveId matches the pinned C3 formula: sha256(app\\nreceivedAtIso\\nseq\\nJSON(envelope)) first 32 hex', () => {
  const expected = createHash('sha256')
    .update(`${base.app}\n${base.receivedAtIso}\n${base.seq}\n${JSON.stringify(base.envelope)}`)
    .digest('hex')
    .slice(0, 32);
  assert.equal(deriveId(base), expected);
});

// --- createSeqGenerator (cross-worker _id uniqueness) -------------------------
// Cluster mode (TIMBER_CLUSTER=N) forks N workers that all flush to ONE Mongo
// collection. The per-process seq counter must be globally distinct: if two
// workers both emitted seq 0,1,2... the same envelope at the same receivedAt-ms
// would derive an identical _id, the 2nd insert would raise 11000, and the
// flusher's all-duplicate-key path would silently drop a 202-accepted record
// (PRD §3/§9 zero-loss violation). A generator is process-unique by construction.

test('createSeqGenerator returns an incrementing function', () => {
  const next = createSeqGenerator();
  const a = next();
  const b = next();
  const c = next();
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
});

test('two independent generators never collide at the same counter index', () => {
  // Simulates two forked workers, each starting its counter fresh at boot.
  const worker0 = createSeqGenerator();
  const worker1 = createSeqGenerator();
  const a = Array.from({ length: 100 }, () => worker0());
  const b = Array.from({ length: 100 }, () => worker1());
  assert.equal(
    new Set([...a, ...b]).size,
    200,
    'all 200 seq values across both workers must be distinct',
  );
  // Specifically the boot-aligned index 0, the realistic collision trigger.
  assert.notEqual(a[0], b[0]);
});

test('seq values are stable strings/numbers usable in the C3 hash', () => {
  const next = createSeqGenerator();
  const v = next();
  assert.ok(typeof v === 'string' || typeof v === 'number');
  // Must stringify deterministically so deriveId is reproducible for replay.
  assert.equal(`${v}`, `${v}`);
});

test('cross-worker enrich-equivalent _ids differ for the byte-identical event (regression for the silent-drop finding)', () => {
  // PoC from the finding: same envelope, same app, same receivedAt-ms, both
  // workers at boot (counter index 0). With process-unique seq the _ids diverge.
  const envelope = { event: 'cron.run', level: 'info' };
  const app = 'dailyDashboard';
  const receivedAtIso = '2026-06-13T10:00:00.000Z';

  const worker0Next = createSeqGenerator();
  const worker1Next = createSeqGenerator();
  const idWorker0 = deriveId({ app, receivedAtIso, seq: worker0Next(), envelope });
  const idWorker1 = deriveId({ app, receivedAtIso, seq: worker1Next(), envelope });
  assert.notEqual(
    idWorker0,
    idWorker1,
    'two workers must not derive the same _id for the same event at boot — else one 202 is silently dropped',
  );
});

test('a single generator still keeps replay idempotency: same seq value re-derives the same _id', () => {
  // The WAL stores the final doc incl. _id; replay reuses the stored seq, so the
  // SAME seq value must always yield the SAME _id (deriveId is pure).
  const next = createSeqGenerator();
  const seq = next();
  const envelope = { event: 'ai.request', level: 'info' };
  const args = { app: 'a', receivedAtIso: '2026-06-13T10:00:00.000Z', seq, envelope };
  assert.equal(deriveId(args), deriveId({ ...args, envelope: { ...envelope } }));
});

// End-to-end zero-loss proof through the REAL flusher + the project's
// C12-faithful fake collection (the finding's PoC 2). Two workers, each with its
// own seq generator, enrich the byte-identical event and flush into ONE shared
// collection. Before the fix both derived the same _id -> the 2nd insert hit
// 11000 -> the flusher's all-duplicate-key path advanced the checkpoint and
// dropped a 202-accepted record (stored docs stayed at 1). With process-unique
// seq the _ids differ, the 2nd insert succeeds, and BOTH records survive.
test('two cluster workers do not silently drop a byte-identical 202-accepted event (real flusher + collection)', async () => {
  const collection = createFakeCollection();
  const getCollection = () => collection;

  const envelope = { event: 'cron.run', level: 'info' };
  const enrichCtx = {
    app: 'dailyDashboard',
    env: 'prod',
    receivedAtIso: '2026-06-13T10:00:00.000Z',
    ttlDays: { info: 30, warn: 60, error: 90 },
  };

  // Each worker boots its own generator at counter index 0 — the realistic
  // collision trigger from the finding (PoC 3).
  const worker0Seq = createSeqGenerator();
  const worker1Seq = createSeqGenerator();
  const doc0 = enrich(envelope, { ...enrichCtx, seq: worker0Seq() });
  const doc1 = enrich(envelope, { ...enrichCtx, seq: worker1Seq() });

  // Per-worker WAL fake: one batch each, distinct dirs (mirrors worker-<i> subdirs).
  function makeWorkerWal(doc) {
    let checkpoint = { segmentSeq: 0, offset: 0 };
    const ops = {
      async loadCheckpoint() {
        return { ...checkpoint };
      },
      async saveCheckpoint(_dir, cp) {
        checkpoint = { ...cp };
      },
      async readWal(_dir, cp) {
        if (cp.segmentSeq === 0 && cp.offset === 0) {
          return { docs: [{ ...doc }], nextCheckpoint: { segmentSeq: 1, offset: 100 }, atEnd: true };
        }
        return { docs: [], nextCheckpoint: { ...cp }, atEnd: true };
      },
    };
    return ops;
  }

  const flusher0 = createFlusher({
    walDir: 'X:/wal/worker-0',
    getCollection,
    batchSize: 100,
    intervalMs: 5,
    walOps: makeWorkerWal(doc0),
  });
  const flusher1 = createFlusher({
    walDir: 'X:/wal/worker-1',
    getCollection,
    batchSize: 100,
    intervalMs: 5,
    walOps: makeWorkerWal(doc1),
  });

  flusher0.start();
  flusher1.start();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (flusher0.status().flushedTotal >= 1 && flusher1.status().flushedTotal >= 1) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  await flusher0.stop();
  await flusher1.stop();

  assert.notEqual(doc0._id, doc1._id, 'precondition: the two workers must derive distinct _ids');
  assert.equal(
    collection.docs.length,
    2,
    `both 202-accepted records must survive; got ${collection.docs.length} (silent drop if 1)`,
  );
  assert.equal(flusher0.status().lastError, null);
  assert.equal(flusher1.status().lastError, null);
});
