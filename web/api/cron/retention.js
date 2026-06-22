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
  const rows = await db()`DELETE FROM events WHERE expires_at < now() RETURNING 1`;
  return json(res, 200, { ok: true, deleted: rows.length });
}
