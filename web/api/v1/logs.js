// /v1/logs — POST ingests one or a batch of events into Neon; GET queries them
// with the full filter surface + keyset pagination. Apps push via POST with a
// write key; the Console reads via GET with a read key.
import { json, badRequest, methodNotAllowed, readJson } from '../_lib/respond.js';
import { requireWrite, requireRead } from '../_lib/auth.js';
import { validateBatch } from '../_lib/validate.js';
import { ttlDays, limits } from '../_lib/env.js';
import { buildInsert } from '../_lib/ingest.js';
import { db } from '../_lib/db.js';
import { parseLogsQuery, runLogs } from '../_lib/sql/logs.js';
import { resolveScope } from '../_lib/projects.js';
import { forwardToLogflare } from '../_lib/logflare.js';

async function ingest(req, res) {
  const principal = requireWrite(req, res);
  if (!principal) return;
  const body = await readJson(req);
  if (!body.ok) return badRequest(res, 'invalid or empty JSON body');
  const v = validateBatch(body.value, limits());
  if (!v.ok) {
    return json(res, v.status ?? 400, v.index != null ? { error: v.error, index: v.index } : { error: v.error });
  }
  const { text, params } = buildInsert(v.events, principal, ttlDays(), new Date());
  // Run Neon insert and Logflare forward in parallel. Neon is the primary store,
  // but when Neon fails (e.g. project size limit reached) we fall back to Logflare:
  // if Logflare accepted the batch the request still succeeds. Only when BOTH
  // fail do we surface an error. v.events is already validated here.
  const [neonResult, logflareResult] = await Promise.allSettled([
    db()(text, params),
    forwardToLogflare(v.events, principal),
  ]);
  if (neonResult.status === 'fulfilled') {
    return json(res, 201, { accepted: v.events.length, rejected: 0 });
  }
  console.error('[timber] neon insert failed', neonResult.reason?.message);
  if (logflareResult.status === 'fulfilled' && logflareResult.value === true) {
    return json(res, 201, { accepted: v.events.length, rejected: 0, store: 'logflare' });
  }
  throw neonResult.reason;
}

async function query(req, res) {
  if (!requireRead(req, res)) return;
  const sp = new URL(req.url, 'http://localhost').searchParams;
  const apps = await resolveScope(sp);
  const parsed = parseLogsQuery(sp, {});
  if (!parsed.ok) return badRequest(res, parsed.error);
  const result = await runLogs(parsed.value, apps);
  return json(res, 200, result);
}

export default async function handler(req, res) {
  if (req.method === 'POST') return ingest(req, res);
  if (req.method === 'GET') return query(req, res);
  return methodNotAllowed(res, 'GET, POST');
}
