// GET /v1/jobs: parseJobsQuery (ported from src/query/jobs.js) + per-job rollups
// over events whose name starts with a configured prefix (default `cron.`).
// failures = level error OR data.status in {error,failed,failure}; latency
// percentiles come from data.latencyMs (non-numeric guarded to NULL).
import { appScopeSql } from '../scope.js';
import { db } from '../db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const OWN_PARAMS = new Set(['from', 'to', 'app']); // `project` stripped by the handler

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);
const parseDate = (raw) => {
  const d = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function parseJobsQuery(searchParams) {
  for (const name of searchParams.keys()) {
    if (!OWN_PARAMS.has(name)) return { ok: false, error: `unknown parameter: ${name}` };
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

export function buildJobsSql(value, prefixes, apps) {
  const { from, to, app } = value;
  const params = [from.toISOString(), to.toISOString()];
  const prefixClauses = prefixes.map((p) => {
    params.push(escapeLike(p) + '%');
    return `event LIKE $${params.length}`;
  });
  const prefixClause = prefixClauses.length ? `(${prefixClauses.join(' OR ')})` : 'false';
  const clauses = ['received_at >= $1', 'received_at < $2', prefixClause];
  const appClause = appScopeSql(app, apps, params);
  if (appClause) clauses.push(appClause);
  const lat = "CASE WHEN (data->>'latencyMs') ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (data->>'latencyMs')::float8 END";
  const text = `
    SELECT
      event AS name,
      count(*)::int AS runs,
      count(*) FILTER (WHERE level = 'error'
        OR lower(coalesce(data->>'status', '')) IN ('error','failed','failure'))::int AS failures,
      max(received_at) AS last_run_at,
      (array_agg(level ORDER BY received_at DESC))[1]          AS last_level,
      (array_agg(data->>'status' ORDER BY received_at DESC))[1] AS last_status_raw,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY ${lat}) AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY ${lat}) AS p95
    FROM events
    WHERE ${clauses.join(' AND ')}
    GROUP BY event
    ORDER BY runs DESC, name ASC
    LIMIT 200`;
  return { text, params };
}

export function mapJobsRows(rows, value) {
  const jobs = rows.map((r) => {
    const statusStr = r.last_status_raw == null ? '' : String(r.last_status_raw).toLowerCase();
    const lastFailed = r.last_level === 'error' || ['error', 'failed', 'failure'].includes(statusStr);
    const runs = Number(r.runs);
    const failures = Number(r.failures);
    return {
      name: r.name,
      lastRunAt: new Date(r.last_run_at).toISOString(),
      lastStatus: lastFailed ? 'failed' : 'ok',
      runs,
      failures,
      successRate: runs ? Math.round(((runs - failures) / runs) * 10000) / 10000 : null,
      p50Ms: r.p50 == null ? null : Number(r.p50),
      p95Ms: r.p95 == null ? null : Number(r.p95),
    };
  });
  return { jobs, window: { from: value.from.toISOString(), to: value.to.toISOString() } };
}

export async function runJobs(value, prefixes, apps) {
  const { text, params } = buildJobsSql(value, prefixes, apps);
  const rows = await db()(text, params);
  return mapJobsRows(rows, value);
}
