// GET /v1/events: parseEventsQuery (ported from src/query/events.js) + SQL that
// returns the distinct event names per app, folded into { apps: { app: [...] } }.
import { appScopeSql } from '../scope.js';
import { db } from '../db.js';

const KNOWN_PARAMS = new Set(['app']);

export function parseEventsQuery(searchParams) {
  for (const name of searchParams.keys()) {
    if (!KNOWN_PARAMS.has(name)) return { ok: false, error: `unknown parameter: ${name}` };
  }
  const app = searchParams.get('app');
  return { ok: true, value: app ? { app } : {} };
}

export function buildEventsSql(value, apps) {
  const params = [];
  const appClause = appScopeSql(value.app, apps, params);
  const whereSql = appClause ? `WHERE ${appClause}` : '';
  const text = `SELECT app, event FROM events ${whereSql} GROUP BY app, event ORDER BY app ASC, event ASC`;
  return { text, params };
}

export function mapEventsRows(rows) {
  const byApp = {};
  for (const r of rows) (byApp[r.app] ??= []).push(r.event);
  return { apps: byApp };
}

export async function runEvents(value, apps) {
  const { text, params } = buildEventsSql(value, apps);
  const rows = await db()(text, params);
  return mapEventsRows(rows);
}
