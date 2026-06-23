// GET /v1/events — known apps and the event names seen for each.
import { json, badRequest, methodNotAllowed } from '../_lib/respond.js';
import { requireRead } from '../_lib/auth.js';
import { parseEventsQuery, runEvents } from '../_lib/sql/events.js';
import { resolveScope } from '../_lib/projects.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  if (!requireRead(req, res)) return;
  const sp = new URL(req.url, 'http://localhost').searchParams;
  const apps = await resolveScope(sp);
  const parsed = parseEventsQuery(sp);
  if (!parsed.ok) return badRequest(res, parsed.error);
  const result = await runEvents(parsed.value, apps);
  return json(res, 200, result);
}
