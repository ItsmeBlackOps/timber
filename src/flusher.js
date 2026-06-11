const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 30000;

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
  let running = false;
  let stopRequested = false;
  let caughtUp = false;
  let lastError = null;
  let flushedTotal = 0;
  let loopPromise = null;
  let wake = null;

  function sleep(ms) {
    if (stopRequested) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = finish; // stop() calls this to abort the wait immediately
    });
  }

  async function runLoop() {
    let ops = null;
    let checkpoint = null; // loaded once, then kept in memory
    let backoffMs = BACKOFF_MIN_MS;
    while (!stopRequested) {
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
          backoffMs = BACKOFF_MIN_MS;
          continue;
        }

        if (
          nextCheckpoint.segmentSeq !== checkpoint.segmentSeq ||
          nextCheckpoint.offset !== checkpoint.offset
        ) {
          // Bytes consumed without yielding docs (skipped corrupt lines): persist
          // the advance so they are not re-scanned forever.
          await ops.saveCheckpoint(walDir, nextCheckpoint);
          checkpoint = nextCheckpoint;
          continue;
        }

        if (atEnd) caughtUp = true;
        await sleep(intervalMs);
      } catch (err) {
        lastError = errorMessage(err);
        emit(`flusher: cycle failed: ${lastError}`);
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    stopRequested = false;
    loopPromise = runLoop().finally(() => {
      running = false;
    });
  }

  async function stop() {
    stopRequested = true;
    if (wake) wake();
    await loopPromise;
    loopPromise = null;
  }

  function status() {
    return { running, caughtUp, lastError, flushedTotal };
  }

  return { start, stop, status };
}
