// GET /v1/facets: parseFacetsQuery (ported from src/query/facets.js) + SQL that
// discovers the distinct ids.* keys and data.* paths present in the window, so
// the Console can offer a live "find by" picker without a fixed schema.
import { appScopeSql } from '../scope.js';
import { db } from '../db.js';

const KNOWN_PARAMS = new Set(['app', 'from', 'to']);
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(raw) {
  const d = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseFacetsQuery(searchParams) {
  for (const name of searchParams.keys()) {
    if (!KNOWN_PARAMS.has(name)) return { ok: false, error: `unknown parameter: ${name}` };
  }
  const toRaw = searchParams.get('to');
  let to = new Date();
  if (toRaw !== null) {
    to = parseDate(toRaw);
    if (to === null) return { ok: false, error: 'to: expected ISO-8601 date or epoch milliseconds' };
  }
  const fromRaw = searchParams.get('from');
  let from = new Date(to.getTime() - DAY_MS);
  if (fromRaw !== null) {
    from = parseDate(fromRaw);
    if (from === null) return { ok: false, error: 'from: expected ISO-8601 date or epoch milliseconds' };
  }
  if (from.getTime() >= to.getTime()) {
    return { ok: false, error: 'from must be earlier than to (got an inverted or empty time window)' };
  }
  const value = { from, to };
  const app = searchParams.get('app');
  if (app) value.app = app;
  return { ok: true, value };
}

export function buildFacetsSql(value, apps) {
  const { from, to, app } = value;
  const params = [from.toISOString(), to.toISOString()];
  const appClause = appScopeSql(app, apps, params);
  const scope = appClause ? ` AND ${appClause}` : '';
  const text = `
    SELECT 'ids' AS kind, jsonb_object_keys(ids) AS k FROM events
      WHERE received_at >= $1 AND received_at < $2${scope} AND ids IS NOT NULL
    UNION
    SELECT 'data' AS kind, jsonb_object_keys(data) AS k FROM events
      WHERE received_at >= $1 AND received_at < $2${scope} AND data IS NOT NULL`;
  return { text, params };
}

export function mapFacetsRows(rows, value) {
  const idsKeys = [];
  const dataPaths = [];
  for (const r of rows) (r.kind === 'ids' ? idsKeys : dataPaths).push(r.k);
  return {
    window: { from: value.from.toISOString(), to: value.to.toISOString() },
    idsKeys: idsKeys.sort(),
    dataPaths: dataPaths.sort(),
  };
}

export async function runFacets(value, apps) {
  const { text, params } = buildFacetsSql(value, apps);
  const rows = await db()(text, params);
  return mapFacetsRows(rows, value);
}
