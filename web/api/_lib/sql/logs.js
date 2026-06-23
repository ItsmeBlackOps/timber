// GET /v1/logs: parseLogsQuery (the limit clamp on top of the shared filter
// builder, ported from src/query/logs.js) + buildLogsSql + runLogs. Keyset
// pagination on (received_at, id) descending; fetch limit+1 to detect a next page.
import { buildWhere } from '../where.js';
import { appScopeSql } from '../scope.js';
import { encodeCursor } from '../cursor.js';
import { db } from '../db.js';

const INT_RE = /^-?\d+$/;

export function parseLogsQuery(searchParams, limits = {}) {
  const maxLimit = limits.maxLimit ?? 500;
  const defaultLimit = limits.defaultLimit ?? 100;
  const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams);

  const where = buildWhere(params);
  if (!where.ok) return where;

  let limit = defaultLimit;
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    if (!INT_RE.test(rawLimit)) return { ok: false, error: `invalid limit "${rawLimit}"` };
    limit = Math.min(Math.max(Number(rawLimit), 1), maxLimit);
  }
  return { ok: true, value: { where, limit } };
}

export function buildLogsSql({ where, limit }, apps) {
  const params = [...where.params];
  const clauses = [...where.clauses];
  const appClause = appScopeSql(where.value.app, apps, params);
  if (appClause) clauses.push(appClause);
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit + 1);
  const text =
    'SELECT id, app, env, event, level, ts, message, ids, data, received_at, expires_at ' +
    `FROM events ${whereSql} ORDER BY received_at DESC, id DESC LIMIT $${params.length}`;
  return { text, params };
}

function toDoc(r) {
  const doc = { _id: String(r.id), app: r.app, env: r.env, event: r.event, level: r.level };
  if (r.ts != null) doc.ts = new Date(r.ts).toISOString();
  if (r.message != null) doc.message = r.message;
  if (r.ids != null) doc.ids = r.ids;
  if (r.data != null) doc.data = r.data;
  doc.receivedAt = new Date(r.received_at).toISOString();
  doc.expiresAt = new Date(r.expires_at).toISOString();
  return doc;
}

export async function runLogs(value, apps) {
  const { text, params } = buildLogsSql(value, apps);
  const rows = await db()(text, params);
  let items = rows;
  let nextCursor = null;
  if (rows.length > value.limit) {
    items = rows.slice(0, value.limit);
    const last = items[items.length - 1];
    nextCursor = encodeCursor({ receivedAt: new Date(last.received_at), id: Number(last.id) });
  }
  return { items: items.map(toDoc), nextCursor };
}
