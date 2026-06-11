import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SEGMENT_RE = /^seg-(\d{13})\.ndjson$/;
const READ_CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;

async function listSegments(dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const segs = [];
  for (const name of names) {
    const m = SEGMENT_RE.exec(name);
    if (m) segs.push({ seq: Number(m[1]), path: join(dir, name) });
  }
  return segs.sort((a, b) => a.seq - b.seq);
}

// Scan one segment from a byte offset.
//   docs       parsed docs (complete-but-corrupt lines are skipped, their bytes consumed)
//   consumed   bytes of complete lines processed; a torn tail is never consumed
//   reachedEof scanned every readable byte (false => stopped early on maxDocs)
//   torn       reachedEof with trailing bytes that lack a closing '\n'
async function readSegmentFrom(path, startOffset, maxDocs) {
  const out = { docs: [], consumed: 0, reachedEof: false, torn: false };
  if (maxDocs <= 0) return out;
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') {
      out.reachedEof = true; // raced with the janitor: nothing left to read here
      return out;
    }
    throw err;
  }
  try {
    // size is snapshotted once: concurrent writer appends are picked up next call
    const { size } = await fh.stat();
    let pos = Math.min(startOffset, size);
    let pending = Buffer.alloc(0);
    for (;;) {
      let lineStart = 0;
      while (out.docs.length < maxDocs) {
        const nl = pending.indexOf(NEWLINE, lineStart);
        if (nl === -1) break;
        out.consumed += nl + 1 - lineStart;
        try {
          out.docs.push(JSON.parse(pending.toString('utf8', lineStart, nl)));
        } catch {
          // complete but corrupt line: drop the doc, keep its bytes consumed
        }
        lineStart = nl + 1;
      }
      if (lineStart > 0) pending = pending.subarray(lineStart);
      if (out.docs.length >= maxDocs) {
        out.reachedEof = pos >= size && pending.length === 0;
        return out;
      }
      if (pos >= size) {
        out.reachedEof = true;
        out.torn = pending.length > 0;
        return out;
      }
      const want = Math.min(READ_CHUNK_BYTES, size - pos);
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      if (bytesRead <= 0) {
        out.reachedEof = true;
        out.torn = pending.length > 0;
        return out;
      }
      pos += bytesRead;
      const chunk = buf.subarray(0, bytesRead);
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    }
  } finally {
    await fh.close();
  }
}

export async function readWal(dir, checkpoint, maxDocs) {
  const docs = [];
  let cp = {
    segmentSeq: checkpoint?.segmentSeq ?? 0,
    offset: checkpoint?.offset ?? 0,
  };
  const segs = await listSegments(dir);
  let idx = segs.findIndex((s) => s.seq >= cp.segmentSeq);
  if (idx === -1) return { docs, nextCheckpoint: cp, atEnd: true };
  if (segs[idx].seq !== cp.segmentSeq) {
    // checkpoint segment was janitor-deleted: resume at the next existing one
    cp = { segmentSeq: segs[idx].seq, offset: 0 };
  }
  for (;;) {
    const isLast = idx === segs.length - 1;
    const r = await readSegmentFrom(segs[idx].path, cp.offset, maxDocs - docs.length);
    docs.push(...r.docs);
    cp = { segmentSeq: cp.segmentSeq, offset: cp.offset + r.consumed };
    if (!r.reachedEof) return { docs, nextCheckpoint: cp, atEnd: false };
    if (isLast) {
      // a torn tail here belongs to the active segment: the writer may still
      // complete it, so stop before it and report end-of-readable
      return { docs, nextCheckpoint: cp, atEnd: true };
    }
    // Segment exhausted and a later one exists: advance to {laterSeq, 0}.
    // A torn tail in a sealed segment can never grow (the writer never reopens
    // old files) and its bytes were never acked, so it is safe to abandon.
    idx += 1;
    cp = { segmentSeq: segs[idx].seq, offset: 0 };
    if (docs.length >= maxDocs) return { docs, nextCheckpoint: cp, atEnd: false };
  }
}

export async function backlogBytes(dir, checkpoint) {
  const segmentSeq = checkpoint?.segmentSeq ?? 0;
  const offset = checkpoint?.offset ?? 0;
  const segs = await listSegments(dir);
  let total = 0;
  for (const seg of segs) {
    if (seg.seq < segmentSeq) continue;
    let size;
    try {
      ({ size } = await stat(seg.path));
    } catch (err) {
      if (err.code === 'ENOENT') continue; // deleted between readdir and stat
      throw err;
    }
    total += seg.seq === segmentSeq ? Math.max(0, size - offset) : size;
  }
  return total;
}
