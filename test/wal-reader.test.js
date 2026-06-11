import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkTmpDir, rmTmpDir } from './helpers/tmp.js';
import { loadCheckpoint, saveCheckpoint } from '../src/wal/checkpoint.js';
import { readWal, backlogBytes } from '../src/wal/reader.js';

const dirs = [];
async function freshDir() {
  const dir = await mkTmpDir('timber-walreader-');
  dirs.push(dir);
  return dir;
}
after(async () => {
  await Promise.all(dirs.map((d) => rmTmpDir(d)));
});

function segName(seq) {
  return `seg-${String(seq).padStart(13, '0')}.ndjson`;
}

function doc(n, extra = {}) {
  return {
    _id: `id-${String(n).padStart(28, '0')}`,
    app: 'web',
    env: 'prod',
    event: 'cron.run',
    level: 'info',
    message: `event number ${n}`,
    receivedAt: '2026-06-11T10:00:00.000Z',
    expiresAt: '2026-07-11T10:00:00.000Z',
    ...extra,
  };
}

function line(d) {
  return JSON.stringify(d) + '\n';
}

const bytes = (s) => Buffer.byteLength(s, 'utf8');

async function writeSegment(dir, seq, content) {
  await writeFile(join(dir, segName(seq)), content, 'utf8');
}

test('loadCheckpoint: missing file -> {segmentSeq:0, offset:0}', async () => {
  const dir = await freshDir();
  assert.deepEqual(await loadCheckpoint(dir), { segmentSeq: 0, offset: 0 });
});

test('checkpoint: save + load roundtrip', async () => {
  const dir = await freshDir();
  await saveCheckpoint(dir, { segmentSeq: 7, offset: 1234 });
  assert.deepEqual(await loadCheckpoint(dir), { segmentSeq: 7, offset: 1234 });
});

test('saveCheckpoint: atomic write leaves no .tmp; file carries updatedAt ISO; rename-over works twice', async () => {
  const dir = await freshDir();
  await saveCheckpoint(dir, { segmentSeq: 1, offset: 10 });
  await saveCheckpoint(dir, { segmentSeq: 2, offset: 20 });
  const names = await readdir(dir);
  assert.ok(names.includes('checkpoint.json'));
  assert.ok(!names.some((n) => n.endsWith('.tmp')));
  const raw = JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8'));
  assert.equal(raw.segmentSeq, 2);
  assert.equal(raw.offset, 20);
  assert.ok(Number.isFinite(Date.parse(raw.updatedAt)));
  assert.deepEqual(await loadCheckpoint(dir), { segmentSeq: 2, offset: 20 });
});

test('loadCheckpoint: corrupt or malformed file -> {segmentSeq:0, offset:0}', async () => {
  const cases = [
    'not json {{{',
    '[]',
    '"x"',
    '{"segmentSeq":"x","offset":0}',
    '{"segmentSeq":1.5,"offset":3}',
    '{"segmentSeq":2,"offset":-1}',
    '{"segmentSeq":2}',
  ];
  for (const content of cases) {
    const dir = await freshDir();
    await writeFile(join(dir, 'checkpoint.json'), content, 'utf8');
    assert.deepEqual(
      await loadCheckpoint(dir),
      { segmentSeq: 0, offset: 0 },
      `content: ${content}`,
    );
  }
});

test('readWal: empty dir -> no docs, atEnd true, checkpoint unchanged', async () => {
  const dir = await freshDir();
  const r = await readWal(dir, { segmentSeq: 0, offset: 0 }, 10);
  assert.deepEqual(r, {
    docs: [],
    nextCheckpoint: { segmentSeq: 0, offset: 0 },
    atEnd: true,
  });
});

test('readWal: reads docs from a byte offset (multibyte-safe); ignores non-segment files', async () => {
  const dir = await freshDir();
  // multibyte chars make byte length differ from char length: catches char-based offsets
  const d1 = doc(1, { message: 'héllo — ünïcode ✓' });
  const d2 = doc(2);
  const d3 = doc(3);
  const [l1, l2, l3] = [line(d1), line(d2), line(d3)];
  await writeSegment(dir, 1, l1 + l2 + l3);
  await writeFile(join(dir, 'checkpoint.json'), '{"segmentSeq":1,"offset":0}', 'utf8');
  await writeFile(join(dir, 'checkpoint.json.tmp'), 'x', 'utf8');
  await writeFile(join(dir, 'notes.txt'), 'not a segment', 'utf8');

  const r = await readWal(dir, { segmentSeq: 1, offset: bytes(l1) }, 100);
  assert.deepEqual(r.docs, [d2, d3]);
  assert.deepEqual(r.nextCheckpoint, { segmentSeq: 1, offset: bytes(l1 + l2 + l3) });
  assert.equal(r.atEnd, true);
});

test('readWal: maxDocs honored within one segment; resume from returned checkpoint', async () => {
  const dir = await freshDir();
  const [l1, l2, l3] = [line(doc(1)), line(doc(2)), line(doc(3))];
  await writeSegment(dir, 1, l1 + l2 + l3);

  const r = await readWal(dir, { segmentSeq: 1, offset: 0 }, 2);
  assert.deepEqual(r.docs, [doc(1), doc(2)]);
  assert.deepEqual(r.nextCheckpoint, { segmentSeq: 1, offset: bytes(l1 + l2) });
  assert.equal(r.atEnd, false);

  const r2 = await readWal(dir, r.nextCheckpoint, 2);
  assert.deepEqual(r2.docs, [doc(3)]);
  assert.deepEqual(r2.nextCheckpoint, { segmentSeq: 1, offset: bytes(l1 + l2 + l3) });
  assert.equal(r2.atEnd, true);
});

test('readWal: maxDocs filled exactly at the end of the last segment -> atEnd true', async () => {
  const dir = await freshDir();
  const [l1, l2] = [line(doc(1)), line(doc(2))];
  await writeSegment(dir, 1, l1 + l2);
  const r = await readWal(dir, { segmentSeq: 1, offset: 0 }, 2);
  assert.deepEqual(r.docs, [doc(1), doc(2)]);
  assert.deepEqual(r.nextCheckpoint, { segmentSeq: 1, offset: bytes(l1 + l2) });
  assert.equal(r.atEnd, true);
});

test('readWal: maxDocs spans a segment boundary', async () => {
  const dir = await freshDir();
  const [a1, a2] = [line(doc(1)), line(doc(2))];
  const [b1, b2] = [line(doc(3)), line(doc(4))];
  await writeSegment(dir, 1, a1 + a2);
  await writeSegment(dir, 2, b1 + b2);

  const r = await readWal(dir, { segmentSeq: 1, offset: 0 }, 3);
  assert.deepEqual(r.docs, [doc(1), doc(2), doc(3)]);
  assert.deepEqual(r.nextCheckpoint, { segmentSeq: 2, offset: bytes(b1) });
  assert.equal(r.atEnd, false);
});

test('readWal: exhausted segment with a later one (seq gap) -> nextCheckpoint {laterSeq, 0}', async () => {
  const dir = await freshDir();
  const [a1, a2] = [line(doc(1)), line(doc(2))];
  await writeSegment(dir, 1, a1 + a2);
  await writeSegment(dir, 3, line(doc(3)));

  const r = await readWal(dir, { segmentSeq: 1, offset: 0 }, 2);
  assert.deepEqual(r.docs, [doc(1), doc(2)]);
  assert.deepEqual(r.nextCheckpoint, { segmentSeq: 3, offset: 0 });
  assert.equal(r.atEnd, false);

  const r2 = await readWal(dir, r.nextCheckpoint, 10);
  assert.deepEqual(r2.docs, [doc(3)]);
  assert.deepEqual(r2.nextCheckpoint, { segmentSeq: 3, offset: bytes(line(doc(3))) });
  assert.equal(r2.atEnd, true);
});

test('readWal: torn tail in last segment -> stop before it, atEnd true, checkpoint not past it', async () => {
  const dir = await freshDir();
  const [l1, l2] = [line(doc(1)), line(doc(2))];
  const full = line(doc(3));
  const tornHead = full.slice(0, 12);
  await writeSegment(dir, 1, l1 + l2 + tornHead);

  const r = await readWal(dir, { segmentSeq: 1, offset: 0 }, 100);
  assert.deepEqual(r.docs, [doc(1), doc(2)]);
  assert.deepEqual(r.nextCheckpoint, { segmentSeq: 1, offset: bytes(l1 + l2) });
  assert.equal(r.atEnd, true);

  // completing the tail later must surface the doc from the same checkpoint: proves nothing was skipped
  await appendFile(join(dir, segName(1)), full.slice(12), 'utf8');
  const r2 = await readWal(dir, r.nextCheckpoint, 100);
  assert.deepEqual(r2.docs, [doc(3)]);
  assert.deepEqual(r2.nextCheckpoint, { segmentSeq: 1, offset: bytes(l1 + l2 + full) });
  assert.equal(r2.atEnd, true);
});

test('readWal: segment holding only a torn fragment -> no docs, offset stays put', async () => {
  const dir = await freshDir();
  await writeSegment(dir, 1, '{"torn":');
  const r = await readWal(dir, { segmentSeq: 1, offset: 0 }, 10);
  assert.deepEqual(r, {
    docs: [],
    nextCheckpoint: { segmentSeq: 1, offset: 0 },
    atEnd: true,
  });
});

test('readWal: complete-but-corrupt line skipped; checkpoint advances past it', async () => {
  const dir = await freshDir();
  const l1 = line(doc(1));
  const corrupt = '{"broken": tru\n';
  const l3 = line(doc(3));
  await writeSegment(dir, 1, l1 + corrupt + l3);

  const r = await readWal(dir, { segmentSeq: 1, offset: 0 }, 100);
  assert.deepEqual(r.docs, [doc(1), doc(3)]);
  assert.deepEqual(r.nextCheckpoint, { segmentSeq: 1, offset: bytes(l1 + corrupt + l3) });
  assert.equal(r.atEnd, true);
});

test('readWal: checkpoint segment janitor-deleted -> starts at next existing seq with offset 0', async () => {
  const dir = await freshDir();
  const [b1, b2] = [line(doc(10)), line(doc(11))];
  await writeSegment(dir, 3, b1 + b2);

  const r = await readWal(dir, { segmentSeq: 1, offset: 999 }, 100);
  assert.deepEqual(r.docs, [doc(10), doc(11)]);
  assert.deepEqual(r.nextCheckpoint, { segmentSeq: 3, offset: bytes(b1 + b2) });
  assert.equal(r.atEnd, true);
});

test('readWal: torn tail in a non-final segment is abandoned, reader advances to the next segment', async () => {
  // After a crash the old active segment can end torn and the writer opens a new
  // segment (it never reopens old files), so the reader must not wedge on it.
  const dir = await freshDir();
  const a1 = line(doc(1));
  await writeSegment(dir, 1, a1 + '{"torn":');
  const b1 = line(doc(2));
  await writeSegment(dir, 2, b1);

  const r = await readWal(dir, { segmentSeq: 1, offset: 0 }, 100);
  assert.deepEqual(r.docs, [doc(1), doc(2)]);
  assert.deepEqual(r.nextCheckpoint, { segmentSeq: 2, offset: bytes(b1) });
  assert.equal(r.atEnd, true);
});

test('backlogBytes: partial current segment + all later segments', async () => {
  const dir = await freshDir();
  const s1 = line(doc(1)) + line(doc(2));
  const s2 = line(doc(3));
  const s3 = line(doc(4)) + line(doc(5));
  await writeSegment(dir, 1, s1);
  await writeSegment(dir, 2, s2);
  await writeSegment(dir, 3, s3);
  const [b1, b2, b3] = [bytes(s1), bytes(s2), bytes(s3)];

  assert.equal(await backlogBytes(dir, { segmentSeq: 0, offset: 0 }), b1 + b2 + b3);
  assert.equal(await backlogBytes(dir, { segmentSeq: 1, offset: 0 }), b1 + b2 + b3);
  assert.equal(await backlogBytes(dir, { segmentSeq: 2, offset: 5 }), b2 - 5 + b3);
  assert.equal(await backlogBytes(dir, { segmentSeq: 3, offset: b3 }), 0);
});

test('backlogBytes: offset overshoot floors at 0; deleted checkpoint segment counts later only', async () => {
  const dir = await freshDir();
  const s2 = line(doc(1));
  const s3 = line(doc(2)) + line(doc(3));
  await writeSegment(dir, 2, s2);
  await writeSegment(dir, 3, s3);

  assert.equal(await backlogBytes(dir, { segmentSeq: 2, offset: bytes(s2) + 100 }), bytes(s3));
  assert.equal(await backlogBytes(dir, { segmentSeq: 1, offset: 42 }), bytes(s2) + bytes(s3));
  assert.equal(await backlogBytes(dir, { segmentSeq: 9, offset: 0 }), 0);

  const empty = await freshDir();
  assert.equal(await backlogBytes(empty, { segmentSeq: 0, offset: 0 }), 0);
});
