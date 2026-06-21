// GET /v1/events backend (contract C10): distinct event names seen per app.

import { appScope } from './scope.js';

const KNOWN_PARAMS = new Set(['app']);

// Mirror the unknown-parameter rejection that parseLogsQuery/parseStatsQuery do,
// so the query surface is consistent: a typo'd filter is a 400, not a silently
// ignored 200.
export function parseEventsQuery(searchParams) {
  for (const name of searchParams.keys()) {
    if (!KNOWN_PARAMS.has(name)) return { ok: false, error: `unknown parameter: ${name}` };
  }
  const app = searchParams.get('app');
  return { ok: true, value: app ? { app } : {} };
}

export async function runEvents(collection, { app, apps } = {}, { maxTimeMS } = {}) {
  const scope = appScope(app, apps);
  const pipeline = [
    ...(Object.keys(scope).length ? [{ $match: scope }] : []),
    { $group: { _id: { app: '$app', event: '$event' } } },
    { $group: { _id: '$_id.app', events: { $addToSet: '$_id.event' } } },
    { $sort: { _id: 1 } },
  ];
  // maxTimeMS caps the scan server-side (defense-in-depth); 0/absent = uncapped.
  const opts = Number.isFinite(maxTimeMS) && maxTimeMS > 0 ? { maxTimeMS } : undefined;
  const rows = await collection.aggregate(pipeline, opts).toArray();
  const byApp = {};
  // rows arrive app-asc from $sort; insertion order keeps the response keys sorted.
  for (const row of rows) byApp[row._id] = [...row.events].sort();
  return { apps: byApp };
}
