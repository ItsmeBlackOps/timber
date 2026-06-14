import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlusher } from '../src/flusher.js';

const WAL_DIR = 'X:/fake-wal-dir';
const RECEIVED_ISO = '2026-06-11T10:00:00.000Z';
const EXPIRES_ISO = '2026-07-11T10:00:00.000Z';
const TS_ISO = '2026-06-11T09:59:59.500Z';

function makeDoc(n) {
  return {
    _id: `id-${n}`,
    app: 'demo',
    env: 'prod',
    event: 'unit.test',
    level: 'info',
    ts: TS_ISO,
    message: `doc ${n}`,
    ids: { n: String(n) },
    data: { n },
    receivedAt: RECEIVED_ISO,
    expiresAt: EXPIRES_ISO,
  };
}

// In-memory walOps fake: batches keyed by the checkpoint they are readable at,
// so a re-read after a failed insert returns the same batch (like the real WAL).
function makeWal(batches, initial = { segmentSeq: 0, offset: 0 }) {
  let checkpoint = { ...initial };
  const saved = [];
  const reads = [];
  const sameCp = (a, b) => a.segmentSeq === b.segmentSeq && a.offset === b.offset;
  const ops = {
    async loadCheckpoint(dir) {
      reads.push({ kind: 'loadCheckpoint', dir });
      return { ...checkpoint };
    },
    async saveCheckpoint(dir, cp) {
      checkpoint = { ...cp };
      saved.push({ ...cp });
    },
    async readWal(dir, cp, maxDocs) {
      reads.push({ kind: 'readWal', dir, cp: { ...cp }, maxDocs });
      const batch = batches.find((b) => sameCp(b.at, cp));
      if (!batch) return { docs: [], nextCheckpoint: { ...cp }, atEnd: true };
      const moreAfter = batches.some((b) => sameCp(b.at, batch.next));
      return {
        docs: batch.docs.map((d) => ({ ...d })),
        nextCheckpoint: { ...batch.next },
        atEnd: !moreAfter,
      };
    },
  };
  return {
    ops,
    saved,
    reads,
    get checkpoint() {
      return { ...checkpoint };
    },
  };
}

// Tiny inline collection stub (deliberately NOT test/helpers/fake-collection.js).
function makeCollection(onInsert) {
  const calls = [];
  return {
    calls,
    async insertMany(docs, opts) {
      const call = { docs, opts, at: Date.now() };
      calls.push(call);
      if (onInsert) await onInsert(call, calls.length);
      return { acknowledged: true, insertedCount: docs.length };
    },
  };
}

async function waitFor(cond, { timeoutMs = 5000, stepMs = 5, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

test('flushes WAL docs: insertMany with revived Dates, ordered:false; batchSize/walDir passed through', async () => {
  const docs = [makeDoc(1), makeDoc(2)];
  const wal = makeWal([{ at: { segmentSeq: 0, offset: 0 }, docs, next: { segmentSeq: 1, offset: 240 } }]);
  const coll = makeCollection();
  const flusher = createFlusher({
    walDir: WAL_DIR,
    getCollection: () => coll,
    batchSize: 123,
    intervalMs: 5,
    walOps: wal.ops,
  });
  try {
    flusher.start();
    await waitFor(() => coll.calls.length >= 1, { label: 'insertMany called' });

    assert.equal(coll.calls.length, 1);
    const { docs: inserted, opts } = coll.calls[0];
    assert.deepEqual(opts, { ordered: false });
    assert.equal(inserted.length, 2);
    for (const [i, doc] of inserted.entries()) {
      assert.ok(doc.receivedAt instanceof Date, 'receivedAt revived to Date');
      assert.equal(doc.receivedAt.toISOString(), RECEIVED_ISO);
      assert.ok(doc.expiresAt instanceof Date, 'expiresAt revived to Date');
      assert.equal(doc.expiresAt.toISOString(), EXPIRES_ISO);
      assert.equal(doc.ts, TS_ISO, 'sender ts stays an untouched string');
      assert.equal(doc._id, `id-${i + 1}`);
      assert.deepEqual(doc.data, { n: i + 1 });
    }
    // Source docs must not be mutated by the revive step.
    assert.equal(typeof docs[0].receivedAt, 'string');

    const firstRead = wal.reads.find((r) => r.kind === 'readWal');
    assert.equal(firstRead.dir, WAL_DIR);
    assert.equal(firstRead.maxDocs, 123);
    assert.deepEqual(firstRead.cp, { segmentSeq: 0, offset: 0 });
  } finally {
    await flusher.stop();
  }
});

test('checkpoint advances only after a successful insert (strict ordering)', async () => {
  const order = [];
  let checkpoint = { segmentSeq: 0, offset: 0 };
  const walOps = {
    async loadCheckpoint() {
      return { ...checkpoint };
    },
    async saveCheckpoint(dir, cp) {
      order.push('save');
      checkpoint = { ...cp };
    },
    async readWal(dir, cp) {
      if (cp.segmentSeq === 0 && cp.offset === 0) {
        return { docs: [makeDoc(1)], nextCheckpoint: { segmentSeq: 1, offset: 80 }, atEnd: true };
      }
      return { docs: [], nextCheckpoint: { ...cp }, atEnd: true };
    },
  };
  const coll = makeCollection(() => {
    order.push('insert');
  });
  const flusher = createFlusher({
    walDir: WAL_DIR,
    getCollection: () => coll,
    batchSize: 10,
    intervalMs: 5,
    walOps,
  });
  try {
    flusher.start();
    await waitFor(() => order.length >= 2, { label: 'insert then save' });
    assert.deepEqual(order.slice(0, 2), ['insert', 'save']);
    assert.deepEqual(checkpoint, { segmentSeq: 1, offset: 80 });
  } finally {
    await flusher.stop();
  }
});

test('non-duplicate insert error: checkpoint NOT advanced, lastError set, retried after ~1s backoff', async () => {
  const docs = [makeDoc(1), makeDoc(2), makeDoc(3)];
  const wal = makeWal([{ at: { segmentSeq: 0, offset: 0 }, docs, next: { segmentSeq: 1, offset: 300 } }]);
  const coll = makeCollection((call, n) => {
    if (n === 1) throw new Error('boom: network reset');
  });
  const flusher = createFlusher({
    walDir: WAL_DIR,
    getCollection: () => coll,
    batchSize: 100,
    intervalMs: 5,
    walOps: wal.ops,
  });
  try {
    flusher.start();
    await waitFor(() => flusher.status().lastError !== null, { label: 'lastError set' });
    assert.equal(coll.calls.length, 1);
    assert.equal(wal.saved.length, 0, 'checkpoint must not advance on failure');
    assert.match(flusher.status().lastError, /boom/);
    assert.equal(flusher.status().flushedTotal, 0);

    await waitFor(() => wal.saved.length === 1, { timeoutMs: 10_000, label: 'retry succeeded' });
    assert.equal(coll.calls.length, 2, 'same batch retried exactly once more');
    const gapMs = coll.calls[1].at - coll.calls[0].at;
    assert.ok(gapMs >= 900, `retry waited for backoff (gap ${gapMs}ms)`);
    assert.deepEqual(wal.saved[0], { segmentSeq: 1, offset: 300 });
    assert.equal(flusher.status().flushedTotal, 3);
  } finally {
    await flusher.stop();
  }
});

test('all-11000 writeErrors treated as success: checkpoint advances, no lastError', async () => {
  const docs = [makeDoc(1), makeDoc(2)];
  const wal = makeWal([{ at: { segmentSeq: 0, offset: 0 }, docs, next: { segmentSeq: 1, offset: 200 } }]);
  const coll = makeCollection(() => {
    const err = new Error('E11000 duplicate key');
    err.writeErrors = [
      { code: 11000, index: 0 },
      { code: 11000, index: 1 },
    ];
    err.result = { insertedCount: 0 };
    throw err;
  });
  const flusher = createFlusher({
    walDir: WAL_DIR,
    getCollection: () => coll,
    batchSize: 100,
    intervalMs: 5,
    walOps: wal.ops,
  });
  try {
    flusher.start();
    await waitFor(() => wal.saved.length === 1, { label: 'checkpoint advanced past dupes' });
    assert.deepEqual(wal.saved[0], { segmentSeq: 1, offset: 200 });
    assert.equal(coll.calls.length, 1, 'no retry for replay dupes');
    assert.equal(flusher.status().lastError, null);
    assert.equal(flusher.status().flushedTotal, 2);
  } finally {
    await flusher.stop();
  }
});

test('single-form err.code 11000 (no writeErrors) treated as success', async () => {
  const wal = makeWal([{ at: { segmentSeq: 0, offset: 0 }, docs: [makeDoc(1)], next: { segmentSeq: 0, offset: 90 } }]);
  const coll = makeCollection(() => {
    const err = new Error('E11000 duplicate key');
    err.code = 11000;
    throw err;
  });
  const flusher = createFlusher({
    walDir: WAL_DIR,
    getCollection: () => coll,
    batchSize: 100,
    intervalMs: 5,
    walOps: wal.ops,
  });
  try {
    flusher.start();
    await waitFor(() => wal.saved.length === 1, { label: 'checkpoint advanced' });
    assert.deepEqual(wal.saved[0], { segmentSeq: 0, offset: 90 });
    assert.equal(flusher.status().lastError, null);
    assert.equal(flusher.status().flushedTotal, 1);
  } finally {
    await flusher.stop();
  }
});

test('writeErrors as a single object (driver OneOrMore form) with code 11000 treated as success', async () => {
  const wal = makeWal([{ at: { segmentSeq: 0, offset: 0 }, docs: [makeDoc(1)], next: { segmentSeq: 0, offset: 90 } }]);
  const coll = makeCollection(() => {
    const err = new Error('E11000 duplicate key');
    err.writeErrors = { code: 11000, index: 0 };
    throw err;
  });
  const flusher = createFlusher({
    walDir: WAL_DIR,
    getCollection: () => coll,
    batchSize: 100,
    intervalMs: 5,
    walOps: wal.ops,
  });
  try {
    flusher.start();
    await waitFor(() => wal.saved.length === 1, { label: 'checkpoint advanced' });
    assert.equal(flusher.status().lastError, null);
    assert.equal(flusher.status().flushedTotal, 1);
  } finally {
    await flusher.stop();
  }
});

test('mixed writeErrors (11000 + other) is a real failure: checkpoint NOT advanced', async () => {
  const wal = makeWal([{ at: { segmentSeq: 0, offset: 0 }, docs: [makeDoc(1), makeDoc(2)], next: { segmentSeq: 0, offset: 180 } }]);
  const coll = makeCollection(() => {
    const err = new Error('partial write failure');
    err.code = 11000;
    err.writeErrors = [
      { code: 11000, index: 0 },
      { code: 121, index: 1 },
    ];
    throw err;
  });
  const flusher = createFlusher({
    walDir: WAL_DIR,
    getCollection: () => coll,
    batchSize: 100,
    intervalMs: 5,
    walOps: wal.ops,
  });
  try {
    flusher.start();
    await waitFor(() => flusher.status().lastError !== null, { label: 'lastError set' });
    assert.equal(wal.saved.length, 0);
    assert.equal(flusher.status().flushedTotal, 0);
    assert.match(flusher.status().lastError, /partial write failure/);
  } finally {
    await flusher.stop(); // must also abort the pending backoff sleep promptly
  }
});

test('getCollection() null: no crash, caughtUp stays false, flushes once a collection appears', async () => {
  const wal = makeWal([{ at: { segmentSeq: 0, offset: 0 }, docs: [makeDoc(1)], next: { segmentSeq: 0, offset: 90 } }]);
  const coll = makeCollection();
  let ref = null;
  const flusher = createFlusher({
    walDir: WAL_DIR,
    getCollection: () => ref,
    batchSize: 100,
    intervalMs: 5,
    walOps: wal.ops,
  });
  try {
    flusher.start();
    await waitFor(() => wal.reads.filter((r) => r.kind === 'readWal').length >= 3, {
      label: 'keeps polling while collection is null',
    });
    assert.equal(flusher.status().running, true);
    assert.equal(flusher.status().caughtUp, false);
    assert.equal(flusher.status().lastError, null);
    assert.equal(coll.calls.length, 0);
    assert.equal(wal.saved.length, 0);

    ref = coll;
    await waitFor(() => wal.saved.length === 1, { label: 'flushed after collection appeared' });
    assert.equal(coll.calls.length, 1);
    assert.equal(flusher.status().flushedTotal, 1);
    await waitFor(() => flusher.status().caughtUp === true, { label: 'caught up after drain' });
  } finally {
    await flusher.stop();
  }
});

test('stop() awaits the in-flight cycle: insert + checkpoint save complete before stop resolves', async () => {
  const wal = makeWal([{ at: { segmentSeq: 0, offset: 0 }, docs: [makeDoc(1)], next: { segmentSeq: 0, offset: 90 } }]);
  const coll = makeCollection(async () => {
    await new Promise((r) => setTimeout(r, 150));
  });
  const flusher = createFlusher({
    walDir: WAL_DIR,
    getCollection: () => coll,
    batchSize: 100,
    intervalMs: 5,
    walOps: wal.ops,
  });
  flusher.start();
  await waitFor(() => coll.calls.length === 1, { label: 'insert in flight' });
  assert.equal(wal.saved.length, 0, 'insert still in flight');

  await flusher.stop();
  assert.equal(wal.saved.length, 1, 'in-flight cycle finished before stop resolved');
  assert.equal(flusher.status().flushedTotal, 1);
  assert.equal(flusher.status().running, false);

  const readsAtStop = wal.reads.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(wal.reads.length, readsAtStop, 'loop fully exited after stop');
});

test('flushedTotal accumulates across batches; caughtUp true after multi-batch drain', async () => {
  const wal = makeWal([
    { at: { segmentSeq: 0, offset: 0 }, docs: [makeDoc(1), makeDoc(2), makeDoc(3)], next: { segmentSeq: 1, offset: 0 } },
    { at: { segmentSeq: 1, offset: 0 }, docs: [makeDoc(4), makeDoc(5)], next: { segmentSeq: 1, offset: 180 } },
  ]);
  const coll = makeCollection();
  const flusher = createFlusher({
    walDir: WAL_DIR,
    getCollection: () => coll,
    batchSize: 3,
    intervalMs: 5,
    walOps: wal.ops,
  });
  try {
    flusher.start();
    await waitFor(() => flusher.status().caughtUp === true, { label: 'drained' });
    assert.equal(flusher.status().flushedTotal, 5);
    assert.equal(coll.calls.length, 2);
    assert.deepEqual(wal.saved, [
      { segmentSeq: 1, offset: 0 },
      { segmentSeq: 1, offset: 180 },
    ]);
    assert.deepEqual(wal.checkpoint, { segmentSeq: 1, offset: 180 });
  } finally {
    await flusher.stop();
  }
});

test('empty WAL: status() starts clean, drains to caughtUp without inserts; boot uses persisted checkpoint', async () => {
  const wal = makeWal([], { segmentSeq: 7, offset: 4242 });
  const coll = makeCollection();
  const flusher = createFlusher({
    walDir: WAL_DIR,
    getCollection: () => coll,
    batchSize: 100,
    intervalMs: 5,
    walOps: wal.ops,
  });
  assert.deepEqual(flusher.status(), { running: false, caughtUp: false, lastError: null, flushedTotal: 0 });
  try {
    flusher.start();
    assert.equal(flusher.status().running, true);
    await waitFor(() => flusher.status().caughtUp === true, { label: 'caught up on empty wal' });
    assert.equal(coll.calls.length, 0);
    assert.equal(flusher.status().flushedTotal, 0);
    const firstRead = wal.reads.find((r) => r.kind === 'readWal');
    assert.deepEqual(firstRead.cp, { segmentSeq: 7, offset: 4242 }, 'starts from the persisted checkpoint');
  } finally {
    await flusher.stop();
  }
});

test('start() after a completed stop() resumes flushing (loop not permanently dead)', async () => {
  // batch2 is added only AFTER the first stop, so it can only be flushed if the
  // restart genuinely spins the loop back up.
  const batches = [{ at: { segmentSeq: 0, offset: 0 }, docs: [makeDoc(1), makeDoc(2)], next: { segmentSeq: 1, offset: 240 } }];
  const wal = makeWal(batches);
  const coll = makeCollection();
  const flusher = createFlusher({ walDir: WAL_DIR, getCollection: () => coll, batchSize: 100, intervalMs: 5, walOps: wal.ops });

  flusher.start();
  await waitFor(() => flusher.status().flushedTotal === 2, { label: 'batch1 flushed' });
  await flusher.stop();
  assert.equal(flusher.status().running, false);

  batches.push({ at: { segmentSeq: 1, offset: 240 }, docs: [makeDoc(3), makeDoc(4)], next: { segmentSeq: 2, offset: 480 } });
  flusher.start();
  assert.equal(flusher.status().running, true);
  try {
    await waitFor(() => flusher.status().flushedTotal === 4, { label: 'batch2 flushed after restart' });
  } finally {
    await flusher.stop();
  }
});

test('start() issued during a pending stop() keeps the loop alive (not a silent no-op)', async () => {
  const batches = [{ at: { segmentSeq: 0, offset: 0 }, docs: [makeDoc(1)], next: { segmentSeq: 1, offset: 120 } }];
  const wal = makeWal(batches);
  const coll = makeCollection();
  const flusher = createFlusher({ walDir: WAL_DIR, getCollection: () => coll, batchSize: 100, intervalMs: 5, walOps: wal.ops });

  flusher.start();
  await waitFor(() => flusher.status().flushedTotal === 1, { label: 'batch1 flushed' });
  const stopping = flusher.stop(); // do NOT await yet
  flusher.start(); // race: start while the prior stop is still settling
  await stopping;

  assert.equal(flusher.status().running, true, 'a loop is alive after the start/stop race');
  batches.push({ at: { segmentSeq: 1, offset: 120 }, docs: [makeDoc(2)], next: { segmentSeq: 2, offset: 240 } });
  try {
    await waitFor(() => flusher.status().flushedTotal === 2, { label: 'new work flushed by the surviving loop' });
  } finally {
    await flusher.stop();
  }
});
