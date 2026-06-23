// GET /v1/stats: parseStatsQuery (ported verbatim from src/query/stats.js) +
// buildStatsSql + mapStatsRows. Buckets by date_trunc(hour|day); latency
// percentiles, HTTP error rate, and cost/token sums come from the `data` jsonb.
// Non-numeric jsonb values are guarded by a regex CASE (so a bad value yields
// NULL/0 instead of erroring the cast), mirroring Mongo's $convert onError:null.
import { appScopeSql } from '../scope.js';
import { db } from '../db.js';

const GROUPS = ['hour', 'day'];
const KNOWN_PARAMS = new Set(['group', 'from', 'to', 'app', 'event']);
const DAY_MS = 24 * 60 * 60 * 1000;
const NUM_RE = "'^-?[0-9]+(\\.[0-9]+)?$'";
const INT_RE = "'^-?[0-9]+$'";

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

function parseDate(raw) {
  const d = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseStatsQuery(searchParams) {
  for (const name of searchParams.keys()) {
    if (!KNOWN_PARAMS.has(name)) return { ok: false, error: `unknown parameter: ${name}` };
  }
  const groupRaw = searchParams.get('group');
  const group = groupRaw ?? 'hour';
  if (!GROUPS.includes(group)) return { ok: false, error: `group must be one of: ${GROUPS.join(', ')}` };

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
  const value = { group, from, to };
  const app = searchParams.get('app');
  if (app) value.app = app;
  const event = searchParams.get('event');
  if (event) value.event = event;
  return { ok: true, value };
}

export function buildStatsSql(value, apps) {
  const { group, from, to, app, event } = value;
  // $1 group, $2 from, $3 to; appScope + event append after.
  const params = [group, from.toISOString(), to.toISOString()];
  const clauses = ['received_at >= $2', 'received_at < $3'];
  const appClause = appScopeSql(app, apps, params);
  if (appClause) clauses.push(appClause);
  if (event) {
    params.push(escapeLike(event) + '%');
    clauses.push(`event LIKE $${params.length}`);
  }
  const lat = "coalesce(data->>'latencyMs', data->>'durationMs')";
  const text = `
    SELECT
      date_trunc($1, received_at) AS bucket,
      count(*)::int AS total,
      count(*) FILTER (WHERE level = 'debug')::int AS debug,
      count(*) FILTER (WHERE level = 'info')::int  AS info,
      count(*) FILTER (WHERE level = 'warn')::int  AS warn,
      count(*) FILTER (WHERE level = 'error')::int AS error,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY lat) AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY lat) AS p95,
      percentile_cont(0.99) WITHIN GROUP (ORDER BY lat) AS p99,
      count(*) FILTER (WHERE status_num IS NOT NULL)::int AS status_total,
      count(*) FILTER (WHERE status_num >= 400)::int      AS status_errors,
      coalesce(sum(cost), 0)    AS cost_usd,
      coalesce(sum(in_tok), 0)  AS input_tokens,
      coalesce(sum(out_tok), 0) AS output_tokens
    FROM (
      SELECT
        received_at,
        level,
        CASE WHEN ${lat} ~ ${NUM_RE} THEN (${lat})::float8 END AS lat,
        CASE WHEN (data->>'status') ~ ${NUM_RE} THEN (data->>'status')::float8 END AS status_num,
        CASE WHEN (data->>'costUsd') ~ ${NUM_RE} THEN (data->>'costUsd')::float8 ELSE 0 END AS cost,
        CASE WHEN (data->>'inputTokens') ~ ${NUM_RE} THEN (data->>'inputTokens')::float8 ELSE 0 END AS in_tok,
        CASE WHEN (data->>'outputTokens') ~ ${NUM_RE} THEN (data->>'outputTokens')::float8 ELSE 0 END AS out_tok
      FROM events
      WHERE ${clauses.join(' AND ')}
    ) s
    GROUP BY bucket
    ORDER BY bucket ASC`;
  return { text, params };
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

export function mapStatsRows(rows, value) {
  const buckets = rows.map((r) => ({
    bucket: new Date(r.bucket).toISOString(),
    total: Number(r.total),
    counts: { debug: Number(r.debug), info: Number(r.info), warn: Number(r.warn), error: Number(r.error) },
    latency: r.p50 == null ? null : { p50: Number(r.p50), p95: Number(r.p95), p99: Number(r.p99) },
    errorRate: Number(r.status_total) ? Number(r.status_errors) / Number(r.status_total) : null,
    costUsd: round6(Number(r.cost_usd)),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
  }));
  return { group: value.group, from: value.from.toISOString(), to: value.to.toISOString(), buckets };
}

export async function runStats(value, apps) {
  const { text, params } = buildStatsSql(value, apps);
  const rows = await db()(text, params);
  return mapStatsRows(rows, value);
}
