// GET /v1/groupby: parseGroupByQuery (ported from src/query/groupby.js, reuses
// the shared filter builder + a 24h default window) + buildGroupBySql + map.
// Returns top-N groups by count plus an honest otherCount for the long tail.
// The `by` field is whitelisted (BY_RE) and ids.*/data.* paths are passed as a
// #>> path parameter, so the group expression can never inject SQL.
import { buildWhere } from '../where.js';
import { appScopeSql } from '../scope.js';
import { db } from '../db.js';

const BY_RE = /^(app|env|level|event|ids\.[\w.-]+|data\.[\w.-]+)$/;
const MAX_LIKE_CHARS = 128;
const INT_RE = /^-?\d+$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const OWN_PARAMS = new Set(['by', 'limit', 'like', 'cursor']);

const fail = (error) => ({ ok: false, error });
const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const parseDate = (raw) => {
  const d = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function parseGroupByQuery(searchParams) {
  const params = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams);

  const by = params.get('by');
  if (!by || !BY_RE.test(by)) return fail('invalid by field');

  let limit = DEFAULT_LIMIT;
  const rawLimit = params.get('limit');
  if (rawLimit !== null) {
    if (!INT_RE.test(rawLimit)) return fail(`invalid limit "${rawLimit}"`);
    limit = Math.min(Math.max(Number(rawLimit), 1), MAX_LIMIT);
  }

  let like;
  const rawLike = params.get('like');
  if (rawLike !== null) {
    if (rawLike.length > MAX_LIKE_CHARS) return fail(`like exceeds ${MAX_LIKE_CHARS} chars`);
    like = rawLike;
  }

  // Default a 24h window (resource-exhaustion guard, same as facets/stats).
  const toRaw = params.get('to');
  let to = new Date();
  if (toRaw !== null) {
    to = parseDate(toRaw);
    if (to === null) return fail(`invalid to "${toRaw}" (ISO-8601 or epoch-ms expected)`);
  }
  const fromRaw = params.get('from');
  let from = new Date(to.getTime() - DAY_MS);
  if (fromRaw !== null) {
    from = parseDate(fromRaw);
    if (from === null) return fail(`invalid from "${fromRaw}" (ISO-8601 or epoch-ms expected)`);
  }

  // Reuse the logs filter surface (minus groupby's own params); from/to become
  // the resolved window. Unknown params still 400 via buildWhere.
  const filterParams = new URLSearchParams();
  for (const [name, value] of params) {
    if (!OWN_PARAMS.has(name) && name !== 'from' && name !== 'to') filterParams.append(name, value);
  }
  filterParams.set('from', String(from.getTime()));
  filterParams.set('to', String(to.getTime()));
  const where = buildWhere(filterParams);
  if (!where.ok) return where; // surfaces the inverted-window 400 for from >= to

  const value = { by, where, limit, from, to };
  if (like !== undefined) value.like = like;
  return { ok: true, value };
}

// Map a whitelisted `by` to a SQL group expression, pushing a #>> path param for
// ids.*/data.*. The returned string is reused verbatim in SELECT/GROUP BY/HAVING.
function byExpr(by, params) {
  if (by === 'app' || by === 'env' || by === 'level' || by === 'event') return by;
  if (by.startsWith('ids.')) {
    params.push(by.slice('ids.'.length).split('.'));
    return `ids #>> $${params.length}`;
  }
  params.push(by.slice('data.'.length).split('.'));
  return `data #>> $${params.length}`;
}

export function buildGroupBySql(value, apps) {
  const { by, where, limit, like } = value;
  const params = [...where.params];
  const clauses = [...where.clauses];
  const appClause = appScopeSql(where.value.app, apps, params);
  if (appClause) clauses.push(appClause);
  const expr = byExpr(by, params);
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  let having = '';
  if (like !== undefined) {
    params.push('%' + escapeLike(like) + '%');
    having = `HAVING ${expr} ILIKE $${params.length}`;
  }
  params.push(limit);
  const limitPh = `$${params.length}`;

  // sum(count) OVER the full grouped set (a scalar subquery over the CTE)
  // computes the grand total before LIMIT, so otherCount accounts for the tail.
  const text = `
    WITH g AS (
      SELECT ${expr} AS value, count(*)::int AS count
      FROM events ${whereSql}
      GROUP BY ${expr}
      ${having}
    )
    SELECT value, count, (SELECT coalesce(sum(count), 0) FROM g)::int AS total
    FROM g
    ORDER BY count DESC, value ASC NULLS LAST
    LIMIT ${limitPh}`;
  return { text, params };
}

export function mapGroupByRows(rows, value) {
  const total = rows.length ? Number(rows[0].total) : 0;
  const groups = rows.map((r) => ({ value: r.value, count: Number(r.count) }));
  const shown = groups.reduce((s, g) => s + g.count, 0);
  const otherCount = Math.max(0, total - shown);
  const out = { by: value.by, total, groups, otherCount };
  if (value.from instanceof Date && value.to instanceof Date) {
    out.window = { from: value.from.toISOString(), to: value.to.toISOString() };
  }
  return out;
}

export async function runGroupBy(value, apps) {
  const { text, params } = buildGroupBySql(value, apps);
  const rows = await db()(text, params);
  return mapGroupByRows(rows, value);
}
