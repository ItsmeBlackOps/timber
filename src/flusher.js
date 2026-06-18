const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;
// After this many consecutive failed cycles with no forward checkpoint progress
// the flusher is wedged (e.g. a poison document an operator-added validator or
// unique index rejects with a non-11000 code): the same batch re-throws forever,
// the backlog grows unbounded, and healthErrorCategory() collapses lastError into
// a transient-looking category. status().stalled is the distinct, latched signal
// that this is NOT a momentary blip, so /healthz surfaces it separately. Set above
// the count it takes backoff to reach BACKOFF_MAX_MS so a brief outage that recovers
// never trips it.
const STALL_THRESHOLD = 5;

// Real wal modules load lazily inside the loop (contract C6): a top-level import
// would force unit tests to depend on src/wal files existing on disk.
async function loadRealWalOps() {
  const [reader, checkpoint] = await Promise.all([
    import('./wal/reader.js'),
    import('./wal/checkpoint.js'),
  ]);
  return {
    readWal: reader.readWal,
    loadCheckpoint: checkpoint.loadCheckpoint,
    saveCheckpoint: checkpoint.saveCheckpoint,
  };
}

// WAL lines carry ISO strings; Mongo needs BSON Dates for TTL and $dateTrunc.
function reviveDates(doc) {
  const out = { ...doc };
  if (typeof out.receivedAt === 'string') out.receivedAt = new Date(out.receivedAt);
  if (typeof out.expiresAt === 'string') out.expiresAt = new Date(out.expiresAt);
  return out;
}

// Replay after a crash between insert and checkpoint re-inserts the same _ids;
// an error where every write failed with 11000 is therefore success, not failure.
function isAllDuplicateKey(err) {
  if (!err) return false;
  const raw = err.writeErrors;
  const writeErrors = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (writeErrors.length > 0) return writeErrors.every((w) => w?.code === 11000);
  return err.code === 11000;
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

export function createFlusher({ walDir, getCollection, batchSize, intervalMs, log, walOps }) {
  const emit = typeof log === 'function' ? log : () => {};
  let caughtUp = false;
  let lastError = null;
  let flushedTotal = 0;
  // Consecutive failed cycles with no forward checkpoint progress; reset to 0 the
  // moment the flusher makes any progress (a successful insert, a corrupt-line skip
  // advance, or a clean idle cycle). `stalled` latches once it crosses the threshold
  // and clears on the next progress, so it is a precise "still wedged right now" flag.
  let consecutiveFailures = 0;
  let stalled = false;
  // Per-generation control token of the live loop, or null when stopped. Each
  // start() owns its own `stopped` flag (closure-captured below), so a start()
  // that races a not-yet-finished stop() spins up a fresh loop rather than being
  // a silent no-op — and the prior stop() can never cancel the new loop, because
  // they key off different tokens. New generations chain after the previous
  // token's promise so two loops never run concurrently.
  let active = null;
  let tail = Promise.resolve();

  async function runLoop(token) {
    let ops = null;
    let checkpoint = null; // loaded once, then kept in memory
    let backoffMs = BACKOFF_MIN_MS;

    function sleep(ms) {
      if (token.stopped) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(finish, ms);
        // Mirror src/wal/writer.js: an idle flusher must not by itself keep the
        // event loop alive, so any caller that forgets stop() still exits cleanly.
        // stop()'s wake path is unaffected.
        if (typeof timer.unref === 'function') timer.unref();
        function finish() {
          clearTimeout(timer);
          token.wake = null;
          resolve();
        }
        token.wake = finish; // stop() calls this to abort the wait immediately
      });
    }

    while (!token.stopped) {
      try {
        if (!ops) ops = walOps ?? (await loadRealWalOps());
        if (!checkpoint) checkpoint = await ops.loadCheckpoint(walDir);

        const { docs, nextCheckpoint, atEnd } = await ops.readWal(walDir, checkpoint, batchSize);

        if (docs.length > 0) {
          caughtUp = false;
          const collection = getCollection();
          if (!collection) {
            await sleep(intervalMs);
            continue;
          }
          try {
            await collection.insertMany(docs.map(reviveDates), { ordered: false });
          } catch (err) {
            if (!isAllDuplicateKey(err)) throw err;
          }
          // Checkpoint advances only after Mongo acked — the durability core.
          await ops.saveCheckpoint(walDir, nextCheckpoint);
          checkpoint = nextCheckpoint;
          flushedTotal += docs.length;
          // Successful cycle: clear the failure latch so /healthz stops reporting a
          // phantom storage failure after a transient blip recovers, and reset the
          // stall tracking now that the pipeline has made forward progress.
          lastError = null;
          backoffMs = BACKOFF_MIN_MS;
          consecutiveFailures = 0;
          stalled = false;
          continue;
        }

        if (
          nextCheckpoint.segmentSeq !== checkpoint.segmentSeq ||
          nextCheckpoint.offset !== checkpoint.offset
        ) {
          // Bytes consumed without yielding docs (skipped corrupt lines): persist
          // the advance so they are not re-scanned forever. This is forward progress,
          // so clear any failure/stall latch too.
          await ops.saveCheckpoint(walDir, nextCheckpoint);
          checkpoint = nextCheckpoint;
          lastError = null;
          backoffMs = BACKOFF_MIN_MS;
          consecutiveFailures = 0;
          stalled = false;
          continue;
        }

        // Clean idle cycle (nothing to flush): the flusher is healthy, so clear any
        // lingering failure/stall latch before parking on the poll interval.
        if (atEnd) caughtUp = true;
        lastError = null;
        backoffMs = BACKOFF_MIN_MS;
        consecutiveFailures = 0;
        stalled = false;
        await sleep(intervalMs);
      } catch (err) {
        lastError = errorMessage(err);
        emit(`flusher: cycle failed: ${lastError}`);
        consecutiveFailures += 1;
        // Crossing the threshold means the same batch has re-thrown every cycle with
        // no forward progress — a wedged pipeline, not a momentary blip. Latch a
        // distinct signal (separate from the transient-looking lastError category)
        // and shout once so operators/monitoring can tell the difference.
        if (!stalled && consecutiveFailures >= STALL_THRESHOLD) {
          stalled = true;
          emit(
            `flusher: STALLED — ${consecutiveFailures} consecutive failures with no checkpoint progress; ` +
              `durability is halted and the WAL backlog will grow until the disk budget trips. Last error: ${lastError}`,
          );
        }
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      }
    }
  }

  function start() {
    if (active) return;
    const token = { stopped: false, wake: null };
    // Chain after the previous generation's teardown so two loops never overlap.
    token.promise = tail.then(() => (token.stopped ? undefined : runLoop(token)));
    tail = token.promise;
    active = token;
  }

  async function stop() {
    const token = active;
    if (!token) return;
    active = null;
    token.stopped = true;
    if (token.wake) token.wake();
    await token.promise; // only this generation, never a later start()'s loop
  }

  function status() {
    return { running: active !== null, caughtUp, lastError, flushedTotal, stalled };
  }

  return { start, stop, status };
}
