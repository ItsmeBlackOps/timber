// GET /healthz — liveness. Preserves the existing Health response shape so the
// Console health view is unchanged; mongo.connected reflects Postgres
// reachability and flusher.flushedTotal carries the stored row count.
import { db } from './_lib/db.js';
import { json } from './_lib/respond.js';

export default async function handler(_req, res) {
  let connected = false;
  let count = 0;
  try {
    const rows = await db()`SELECT count(*)::int AS n FROM events`;
    count = rows[0].n;
    connected = true;
  } catch {
    connected = false;
  }
  return json(res, 200, {
    ok: connected,
    wal: { totalBytes: 0, backlogBytes: 0, overBudget: false },
    flusher: { running: true, caughtUp: true, flushedTotal: count, lastError: null },
    mongo: { connected },
  });
}
