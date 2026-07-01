// GET /v1/facets — discovered ids.* / data.* facet field names within the window.
import { json, badRequest, methodNotAllowed } from '../_lib/respond.js';
import { requireRead } from '../_lib/auth.js';
import { parseFacetsQuery, runFacets } from '../_lib/sql/facets.js';
import { resolveScope } from '../_lib/projects.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  if (!requireRead(req, res)) return;
  const sp = new URL(req.url, 'http://localhost').searchParams;
  const apps = await resolveScope(sp);
  const parsed = parseFacetsQuery(sp);
  if (!parsed.ok) return badRequest(res, parsed.error);
  const result = await runFacets(parsed.value, apps);
  return json(res, 200, result);
}
