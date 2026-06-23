// GET /v1/stats — bucketed volume / level / error-rate / cost / tokens / latency.
import { json, badRequest, methodNotAllowed } from '../_lib/respond.js';
import { requireRead } from '../_lib/auth.js';
import { parseStatsQuery, runStats } from '../_lib/sql/stats.js';
import { resolveScope } from '../_lib/projects.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  if (!requireRead(req, res)) return;
  const sp = new URL(req.url, 'http://localhost').searchParams;
  const apps = await resolveScope(sp);
  const parsed = parseStatsQuery(sp);
  if (!parsed.ok) return badRequest(res, parsed.error);
  const result = await runStats(parsed.value, apps);
  return json(res, 200, result);
}
