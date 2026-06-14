import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, utimes, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkTmpDir, rmTmpDir } from './helpers/tmp.js';
import { createWalWriter } from '../src/wal/writer.js';

const SEG1 = 'seg-0000000000001.ndjson';
const SEG2 = 'seg-0000000000002.ndjson';
const SEG3 = 'seg-0000000000003.ndjson';
const SEG4 = 'seg-0000000000004.ndjson';

const tmpDirs = [];
const writers = [];

after(async () => {
  for (const w of writers) {
    try {
      await w.close();
    } catch {
      // already closed or failed test — best effort so rmTmpDir can proceed
    }
  }
  for (const dir of tmpDirs) await rmTmpDir(dir);
});

async function freshDir() {
  const dir = await mkTmpDir('timber-walw-');
  tmpDirs.push(dir);
  return dir;
}

async function mkWriter(dir, opts = {}) {
  const w = await createWalWriter({
    dir,
    fsyncMs: 50,
    segmentMaxBytes: 8 * 1024 * 1024,
    budgetBytes: 1024 * 1024 * 1024,
    retainHours: 24,
    ...opts,
  });
  writers.push(w);
  return w;
}

async function segNames(dir) {
  return (await readdir(dir)).filter((n) => n.startsWith('seg-')).sort();
}

test('first segment is seg-0000000000001.ndjson; lines are exact JSON + \\n', async () => {
  const dir = await freshDir();
  const w = await mkWriter(dir);
  assert.equal(w.activeSegmentSeq(), 1);

  const docs = [
    { _id: 'a1', app: 'demo', event: 'x', data: { m: 1 } },
    { _id: 'b2', app: 'demo', event: 'y' },
  ];
  await w.append(docs);
  await w.close();

  assert.deepEqual(await segNames(dir), [SEG1]);
  const content = await readFile(join(dir, SEG1), 'utf8');
  assert.equal(content, JSON.stringify(docs[0]) + '\n' + JSON.stringify(docs[1]) + '\n');
});

test('50 concurrent append() calls keep call order; all lines valid; count right', async () => {
  const dir = await freshDir();
  const w = await mkWriter(dir);

  const calls = [];
  for (let i = 0; i < 50; i++) {
    calls.push(w.append([{ i, k: 0 }, { i, k: 1 }, { i, k: 2 }]));
  }
  await Promise.all(calls);
  await w.close();

  assert.deepEqual(await segNames(dir), [SEG1]);
  const content = await readFile(join(dir, SEG1), 'utf8');
  assert.ok(content.endsWith('\n'));
  const lines = content.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 150);
  lines.forEach((line, idx) => {
    const doc = JSON.parse(line);
    assert.equal(doc.i, Math.floor(idx / 3));
    assert.equal(doc.k, idx % 3);
  });
});

test('rotates to next seq when active size >= segmentMaxBytes', async () => {
  const dir = await freshDir();
  const w = await mkWriter(dir, { segmentMaxBytes: 64 });
  const doc = { _id: 'x'.repeat(80) }; // line ~91 bytes > 64 ⇒ every later append rotates first

  await w.append([doc]);
  assert.equal(w.activeSegmentSeq(), 1);
  await w.append([doc]);
  assert.equal(w.activeSegmentSeq(), 2);
  await w.append([doc]);
  assert.equal(w.activeSegmentSeq(), 3);
  await w.close();

  assert.deepEqual(await segNames(dir), [SEG1, SEG2, SEG3]);
  for (const name of [SEG1, SEG2, SEG3]) {
    assert.equal(await readFile(join(dir, name), 'utf8'), JSON.stringify(doc) + '\n');
  }
});

test('rotates at exact equality (active size == segmentMaxBytes)', async () => {
  const dir = await freshDir();
  const w = await mkWriter(dir, { segmentMaxBytes: 8 });
  await w.append([{ n: 1 }]); // '{"n":1}\n' = exactly 8 bytes
  assert.equal(w.activeSegmentSeq(), 1);
  await w.append([{ n: 2 }]); // 8 >= 8 ⇒ must rotate
  assert.equal(w.activeSegmentSeq(), 2);
  await w.close();
  assert.deepEqual(await segNames(dir), [SEG1, SEG2]);
});

test('boot with existing segments opens maxSeq+1 and never touches old files', async () => {
  const dir = await freshDir();
  await writeFile(join(dir, 'seg-0000000000003.ndjson'), '{"a":1}\n');
  await writeFile(join(dir, 'seg-0000000000007.ndjson'), '{"b":2}\n');
  // non-segment files must be ignored by the seq scan and totalBytes
  await writeFile(join(dir, 'checkpoint.json'), '{"segmentSeq":3,"offset":0}');
  await writeFile(join(dir, 'seg-123.ndjson'), '{"bogus":true}\n'); // not 13-digit ⇒ not a segment
  await writeFile(join(dir, 'notes.txt'), 'ignore me');

  const w = await mkWriter(dir);
  assert.equal(w.activeSegmentSeq(), 8);
  assert.equal(w.totalBytes(), 16); // two 8-byte segments + empty active

  await w.append([{ c: 3 }]);
  await w.close();

  assert.equal(await readFile(join(dir, 'seg-0000000000003.ndjson'), 'utf8'), '{"a":1}\n');
  assert.equal(await readFile(join(dir, 'seg-0000000000007.ndjson'), 'utf8'), '{"b":2}\n');
  assert.equal(await readFile(join(dir, 'seg-0000000000008.ndjson'), 'utf8'), '{"c":3}\n');
});

test('reboot in same dir opens a fresh segment (no reuse, no append to old)', async () => {
  const dir = await freshDir();
  const w1 = await mkWriter(dir);
  await w1.append([{ n: 1 }]);
  await w1.close();

  const w2 = await mkWriter(dir);
  assert.equal(w2.activeSegmentSeq(), 2);
  await w2.append([{ n: 2 }]);
  await w2.close();

  assert.equal(await readFile(join(dir, SEG1), 'utf8'), '{"n":1}\n');
  assert.equal(await readFile(join(dir, SEG2), 'utf8'), '{"n":2}\n');
});

test('creates wal dir recursively when missing', async () => {
  const base = await freshDir();
  const dir = join(base, 'nested', 'wal');
  const w = await mkWriter(dir);
  assert.equal(w.activeSegmentSeq(), 1);
  await w.append([{ ok: true }]);
  await w.close();
  assert.deepEqual(await segNames(dir), [SEG1]);
});

test('totalBytes tracks appended bytes and matches disk', async () => {
  const dir = await freshDir();
  await writeFile(join(dir, SEG1), '{"a":1}\n'); // 8 pre-existing bytes
  const w = await mkWriter(dir);
  assert.equal(w.totalBytes(), 8);

  const docs = [{ x: 1 }, { y: 'abc' }];
  const batchBytes = Buffer.byteLength(docs.map((d) => JSON.stringify(d) + '\n').join(''));
  await w.append(docs);
  assert.equal(w.totalBytes(), 8 + batchBytes);
  await w.close();

  let onDisk = 0;
  for (const name of await segNames(dir)) {
    onDisk += (await stat(join(dir, name))).size;
  }
  assert.equal(onDisk, 8 + batchBytes);
});

test('overBudget flips when totalBytes >= budgetBytes', async () => {
  const dir = await freshDir();
  const w = await mkWriter(dir, { budgetBytes: 100 });
  assert.equal(w.overBudget(), false);
  await w.append([{ pad: 'x'.repeat(120) }]);
  assert.equal(w.overBudget(), true);
  await w.close();
});

test('janitor deletes only segments below checkpoint AND older than retainHours', async () => {
  const dir = await freshDir();
  const w = await mkWriter(dir, { segmentMaxBytes: 1, retainHours: 1 });
  await w.append([{ n: 1 }]); // seg1
  await w.append([{ n: 2 }]); // seg2
  await w.append([{ n: 3 }]); // seg3
  await w.append([{ n: 4 }]); // seg4 (active)
  assert.equal(w.activeSegmentSeq(), 4);
  assert.equal(w.totalBytes(), 32);

  const old = new Date(Date.now() - 2 * 3600 * 1000);
  await utimes(join(dir, SEG1), old, old);
  await utimes(join(dir, SEG2), old, old);

  // seg2 is old but seq 2 is NOT < 2 ⇒ kept (only flushed segments go)
  const r1 = await w.janitor({ segmentSeq: 2, offset: 0 });
  assert.deepEqual(r1.deleted, [SEG1]);
  assert.equal(w.totalBytes(), 24);

  // seg3 is below checkpoint but mtime is recent ⇒ kept; seg2 old ⇒ deleted
  const r2 = await w.janitor({ segmentSeq: 99, offset: 0 });
  assert.deepEqual(r2.deleted, [SEG2]);
  assert.equal(w.totalBytes(), 16);

  assert.deepEqual(await segNames(dir), [SEG3, SEG4]);

  // nothing eligible ⇒ empty result
  const r3 = await w.janitor({ segmentSeq: 99, offset: 0 });
  assert.deepEqual(r3.deleted, []);
  await w.close();
});

test('janitor reclaims flushed segments under budget pressure regardless of mtime, oldest-first', async () => {
  const dir = await freshDir();
  // segMax 1 ⇒ each append after the first rotates first, so every seg holds one 8-byte line
  const w = await mkWriter(dir, { segmentMaxBytes: 1, retainHours: 24, budgetBytes: 25 });
  await w.append([{ n: 1 }]); // seg1, 8 bytes
  await w.append([{ n: 2 }]); // seg2, 8 bytes
  await w.append([{ n: 3 }]); // seg3, 8 bytes
  await w.append([{ n: 4 }]); // seg4 (active), 8 bytes
  assert.equal(w.activeSegmentSeq(), 4);
  assert.equal(w.totalBytes(), 32); // 4 × 8; over the 25-byte budget
  assert.equal(w.overBudget(), true);

  // All three sealed segments are FRESH (recent mtime) and seq 1..3 < checkpoint 4,
  // so the retainHours rule alone would keep them all and ingest would 429 forever.
  // Budget pressure must override mtime: reclaim oldest-first, only as many as needed
  // to drop back under budget (reclaim seg1 ⇒ 24 < 25 ⇒ stop).
  const r = await w.janitor({ segmentSeq: 4, offset: 0 });
  assert.deepEqual(r.deleted, [SEG1]);
  assert.equal(w.totalBytes(), 24);
  assert.equal(w.overBudget(), false); // healthy zero-backlog server is no longer blocked
  assert.deepEqual(await segNames(dir), [SEG2, SEG3, SEG4]);
  await w.close();
});

test('janitor budget pressure never reclaims unflushed backlog (seq >= checkpoint)', async () => {
  const dir = await freshDir();
  const w = await mkWriter(dir, { segmentMaxBytes: 1, retainHours: 24, budgetBytes: 8 });
  await w.append([{ n: 1 }]); // seg1, 8 bytes
  await w.append([{ n: 2 }]); // seg2, 8 bytes
  await w.append([{ n: 3 }]); // seg3 (active), 8 bytes
  assert.equal(w.activeSegmentSeq(), 3);
  assert.equal(w.totalBytes(), 24);
  assert.equal(w.overBudget(), true);

  // Checkpoint at 0 ⇒ NOTHING is flushed; every segment is live backlog. Budget
  // pressure must not delete unacked data, so the janitor reclaims nothing and the
  // 429 stands (this is the PRD Mongo-outage backpressure path).
  const r = await w.janitor({ segmentSeq: 0, offset: 0 });
  assert.deepEqual(r.deleted, []);
  assert.equal(w.totalBytes(), 24);
  assert.equal(w.overBudget(), true);
  assert.deepEqual(await segNames(dir), [SEG1, SEG2, SEG3]);
  await w.close();
});

test('janitor budget pressure reclaims every flushed segment but never the active one', async () => {
  const dir = await freshDir();
  // budget 1 forces reclaim of all flushed segments; the active seg must survive
  const w = await mkWriter(dir, { segmentMaxBytes: 1, retainHours: 24, budgetBytes: 1 });
  await w.append([{ n: 1 }]); // seg1
  await w.append([{ n: 2 }]); // seg2
  await w.append([{ n: 3 }]); // seg3
  await w.append([{ n: 4 }]); // seg4 (active)
  assert.equal(w.activeSegmentSeq(), 4);
  assert.equal(w.totalBytes(), 32);

  // checkpoint past the active seq: seg1..3 are flushed; active seg4 is below
  // checkpoint too but must never be deleted (writer still holds its fd)
  const r = await w.janitor({ segmentSeq: 99, offset: 0 });
  assert.deepEqual(r.deleted, [SEG1, SEG2, SEG3]);
  assert.equal(w.totalBytes(), 8); // only the active segment remains
  assert.deepEqual(await segNames(dir), [SEG4]);
  await w.close();
});

test('close() flushes queued appends, is idempotent, and append after close rejects', async () => {
  const dir = await freshDir();
  const w = await mkWriter(dir);
  const p1 = w.append([{ n: 1 }]);
  const p2 = w.append([{ n: 2 }]);
  await w.close();
  await Promise.all([p1, p2]); // must already be settled-resolved

  assert.equal(await readFile(join(dir, SEG1), 'utf8'), '{"n":1}\n{"n":2}\n');
  await assert.rejects(() => w.append([{ n: 3 }]), /closed/);
  await w.close(); // idempotent
});

test('fsync timer fires with tiny fsyncMs; forceFsync resolves; data intact', async () => {
  const dir = await freshDir();
  const w = await mkWriter(dir, { fsyncMs: 5 });
  await w.append([{ n: 1 }]);
  await sleep(40); // several timer ticks over a dirty then clean file
  await w.append([{ n: 2 }]);
  await w.forceFsync();
  await sleep(15);
  await w.close();
  assert.equal(await readFile(join(dir, SEG1), 'utf8'), '{"n":1}\n{"n":2}\n');
});

test('append([]) resolves without writing', async () => {
  const dir = await freshDir();
  const w = await mkWriter(dir);
  await w.append([]);
  assert.equal(w.totalBytes(), 0);
  await w.close();
  assert.equal(await readFile(join(dir, SEG1), 'utf8'), '');
});
