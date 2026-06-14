import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const SEGMENT_RE = /^seg-(\d{13})\.ndjson$/;

const segmentName = (seq) => `seg-${String(seq).padStart(13, '0')}.ndjson`;

export async function createWalWriter({ dir, fsyncMs, segmentMaxBytes, budgetBytes, retainHours }) {
  await mkdir(dir, { recursive: true });

  const sizes = new Map(); // seq -> bytes; keeps totalBytes() O(1) and janitor accounting exact
  let total = 0;
  let maxSeq = 0;
  for (const name of await readdir(dir)) {
    const m = SEGMENT_RE.exec(name);
    if (!m) continue;
    const seq = Number(m[1]);
    let st;
    try {
      st = await stat(join(dir, name));
    } catch {
      continue;
    }
    sizes.set(seq, st.size);
    total += st.size;
    if (seq > maxSeq) maxSeq = seq;
  }

  let activeSeq = maxSeq + 1;
  // 'ax' = create-only append: guarantees we never write into a pre-existing
  // segment (a torn tail from a previous run stays where the reader can handle it)
  let fh = await open(join(dir, segmentName(activeSeq)), 'ax');
  let activeBytes = 0;
  sizes.set(activeSeq, 0);

  let dirty = false;
  let closed = false;
  let closePromise = null;
  let fsyncQueued = false;

  let tail = Promise.resolve();
  function enqueue(job) {
    const p = tail.then(job);
    tail = p.then(
      () => {},
      () => {}, // a failed job must not wedge the queue for later appends
    );
    return p;
  }

  async function rotate() {
    // fsync before closing, or the finished segment's tail would escape the
    // <=fsyncMs power-loss bound (the timer can't reach a closed fd)
    if (dirty) {
      await fh.sync();
      dirty = false;
    }
    await fh.close();
    activeSeq += 1;
    fh = await open(join(dir, segmentName(activeSeq)), 'ax');
    activeBytes = 0;
    sizes.set(activeSeq, 0);
  }

  async function syncIfDirty() {
    if (dirty && fh) {
      await fh.sync();
      dirty = false; // only cleared on success, so a failed fsync is retried next tick
    }
  }

  const timer = setInterval(() => {
    if (!dirty || fsyncQueued || closed) return;
    fsyncQueued = true;
    enqueue(() => {
      fsyncQueued = false;
      return syncIfDirty();
    }).catch(() => {});
  }, fsyncMs);
  timer.unref();

  function append(docs) {
    if (closed) return Promise.reject(new Error('wal writer is closed'));
    if (!Array.isArray(docs)) return Promise.reject(new TypeError('append expects an array of docs'));
    if (docs.length === 0) return enqueue(() => {});
    // stringify at call time so callers may reuse/mutate doc objects afterwards
    const payload = Buffer.from(docs.map((d) => JSON.stringify(d) + '\n').join(''), 'utf8');
    return enqueue(async () => {
      if (activeBytes >= segmentMaxBytes) await rotate();
      let written = 0;
      while (written < payload.length) {
        const { bytesWritten } = await fh.write(payload, written);
        written += bytesWritten;
      }
      activeBytes += payload.length;
      sizes.set(activeSeq, activeBytes);
      total += payload.length;
      // resolve now: bytes are in the OS buffer (process-crash safe); the
      // fsyncMs timer bounds the power-loss window per PRD section 7.1
      dirty = true;
    });
  }

  function forceFsync() {
    if (closed) return closePromise ?? Promise.resolve();
    return enqueue(syncIfDirty);
  }

  // Delete a single flushed segment file and keep totalBytes() exact. Returns
  // true on success; a transient failure (e.g. Windows lock) is swallowed so the
  // next janitor run retries.
  async function reclaimSegment(seq, name, knownSize) {
    try {
      await unlink(join(dir, name));
    } catch {
      return false;
    }
    total -= sizes.get(seq) ?? knownSize;
    sizes.delete(seq);
    return true;
  }

  async function janitor(checkpoint) {
    const cutoff = Date.now() - retainHours * 3_600_000;
    const deleted = [];
    // Flushed (seq < checkpoint), non-active segments that survive the retain
    // pass, kept oldest-first for the budget-pressure pass below.
    const retained = [];
    for (const name of await readdir(dir)) {
      const m = SEGMENT_RE.exec(name);
      if (!m) continue;
      const seq = Number(m[1]);
      if (seq >= checkpoint.segmentSeq || seq === activeSeq) continue;
      const file = join(dir, name);
      let st;
      try {
        st = await stat(file);
      } catch {
        continue;
      }
      if (st.mtimeMs >= cutoff) {
        retained.push({ seq, name, size: st.size });
        continue;
      }
      if (await reclaimSegment(seq, name, st.size)) deleted.push(name);
    }

    // Budget-pressure override: the disk budget caps total on-disk bytes, so it
    // outranks retainHours. Already-flushed data (seq < checkpoint) is safe to
    // drop because Mongo has it; reclaim oldest-first only until back under
    // budget. Unflushed backlog (seq >= checkpoint) is never touched here, so a
    // real Mongo outage still backs ingest off via overBudget(). Without this a
    // healthy zero-backlog server would 429 forever once retained flushed
    // segments exceeded the budget.
    if (total >= budgetBytes) {
      retained.sort((a, b) => a.seq - b.seq); // oldest first (seq strictly increasing)
      for (const seg of retained) {
        if (total < budgetBytes) break;
        if (await reclaimSegment(seg.seq, seg.name, seg.size)) deleted.push(seg.name);
      }
    }
    return { deleted };
  }

  function close() {
    if (closed) return closePromise;
    closed = true;
    clearInterval(timer);
    closePromise = enqueue(async () => {
      if (!fh) return;
      await fh.sync();
      await fh.close();
      fh = null;
    });
    return closePromise;
  }

  return {
    append,
    forceFsync,
    totalBytes: () => total,
    overBudget: () => total >= budgetBytes,
    activeSegmentSeq: () => activeSeq,
    janitor,
    close,
  };
}
