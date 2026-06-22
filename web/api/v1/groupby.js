// GET /v1/groupby — top-N counts per distinct value of one field (By User =
// ids.userId, By Service = app, AI model = data.model, etc.).
import { json, badRequest, methodNotAllowed } from '../_lib/respond.js';
import { requireRead } from '../_lib/auth.js';
import { parseGroupByQuery, runGroupBy } from '../_lib/sql/groupby.js';
import { resolveScope } from '../_lib/projects.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  if (!requireRead(req, res)) return;
  const sp = new URL(req.url, 'http://localhost').searchParams;
  const apps = await resolveScope(sp);
  const parsed = parseGroupByQuery(sp);
  if (!parsed.ok) return badRequest(res, parsed.error);
  const result = await runGroupBy(parsed.value, apps);
  return json(res, 200, result);
}
