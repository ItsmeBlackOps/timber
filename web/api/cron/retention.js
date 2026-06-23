// Daily retention sweep, invoked by Vercel Cron (see web/vercel.json). Deletes
// rows whose per-level TTL has elapsed (expires_at < now). Secured with
// CRON_SECRET: Vercel sends `Authorization: Bearer $CRON_SECRET` on cron
// invocations, so an unauthenticated caller cannot trigger deletes.
import { db } from '../_lib/db.js';
import { json } from '../_lib/respond.js';
import { cronSecret } from '../_lib/env.js';

export default async function handler(req, res) {
  const secret = cronSecret();
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return json(res, 401, { ok: false });
  }
  // Batch the delete so one cron run never opens an unbounded transaction that
  // could exceed the serverless time limit (or pull millions of RETURNING rows
  // into memory). Postgres has no DELETE ... LIMIT, so bound it via a subselect.
  // Capped per invocation; the daily schedule catches any remainder next run.
  const BATCH = 10_000;
  const MAX_BATCHES = 50;
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const rows = await db()`
      DELETE FROM events
      WHERE id IN (SELECT id FROM events WHERE expires_at < now() LIMIT ${BATCH})
      RETURNING 1`;
    deleted += rows.length;
    if (rows.length < BATCH) break;
  }
  return json(res, 200, { ok: true, deleted });
}
