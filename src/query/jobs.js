// GET /v1/jobs — per-job rollups over job events (name starts with a configured
// prefix, default `cron.`) within a time window + project scope. Mirrors the
// parse/build/run shape of src/query/stats.js.
import { appScope } from './scope.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const OWN_PARAMS = new Set(['from', 'to', 'app']); // `project` is stripped by the handler
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

const toDoubleN = (input) => ({ $convert: { input, to: 'double', onError: null, onNull: null } });
const failedExpr = {
  $cond: [
    {
      $or: [
        { $eq: ['$level', 'error'] },
        { $in: [{ $toLower: { $ifNull: ['$data.status', ''] } }, ['error', 'failed', 'failure']] },
      ],
    },
    1, 0,
  ],
};

export function buildJobsPipeline({ from, to, app, apps }, prefixes) {
  const prefixRe = '^(' + prefixes.map(escapeRegex).join('|') + ')';
  return [
    { $match: { receivedAt: { $gte: from, $lt: to }, event: { $regex: prefixRe }, ...appScope(app, apps) } },
    { $sort: { receivedAt: 1 } },
    {
      $group: {
        _id: '$event',
        runs: { $sum: 1 },
        failures: { $sum: failedExpr },
        lastRunAt: { $last: '$receivedAt' },
        lastLevel: { $last: '$level' },
        lastStatusRaw: { $last: { $ifNull: ['$data.status', null] } },
        latencyP: { $percentile: { input: toDoubleN('$data.latencyMs'), p: [0.5, 0.95], method: 'approximate' } },
      },
    },
    { $sort: { runs: -1, _id: 1 } },
    { $limit: 200 },
  ];
}

export async function runJobs(collection, value, prefixes, { maxTimeMS } = {}) {
  const opts = Number.isFinite(maxTimeMS) && maxTimeMS > 0 ? { maxTimeMS } : undefined;
  const rows = await collection.aggregate(buildJobsPipeline(value, prefixes), opts).toArray();
  const jobs = rows.map((r) => {
    const lp = r.latencyP ?? [null, null];
    const statusStr = r.lastStatusRaw == null ? '' : String(r.lastStatusRaw).toLowerCase();
    const lastFailed = r.lastLevel === 'error' || ['error', 'failed', 'failure'].includes(statusStr);
    return {
      name: r._id,
      lastRunAt: r.lastRunAt,
      lastStatus: lastFailed ? 'failed' : 'ok',
      runs: r.runs,
      failures: r.failures,
      successRate: r.runs ? Math.round(((r.runs - r.failures) / r.runs) * 10000) / 10000 : null,
      p50Ms: lp[0] == null ? null : lp[0],
      p95Ms: lp[1] == null ? null : lp[1],
    };
  });
  return { jobs, window: { from: value.from.toISOString(), to: value.to.toISOString() } };
}
