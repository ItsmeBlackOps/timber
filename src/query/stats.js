// GET /v1/stats backend (contract C9): parse params, build the aggregation
// pipeline ($dateTrunc buckets + §5.3 convention rollups), post-process buckets.

const GROUPS = ['hour', 'day'];
const KNOWN_PARAMS = new Set(['group', 'from', 'to', 'app', 'event']);
const DAY_MS = 24 * 60 * 60 * 1000;

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  if (!GROUPS.includes(group)) {
    return { ok: false, error: `group must be one of: ${GROUPS.join(', ')}` };
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

  const value = { group, from, to };
  const app = searchParams.get('app');
  if (app) value.app = app;
  const event = searchParams.get('event');
  if (event) value.event = event;
  return { ok: true, value };
}

const levelCount = (level) => ({ $sum: { $cond: [{ $eq: ['$level', level] }, 1, 0] } });
// onError/onNull = null keeps the value out of $percentile / $cond counting;
// = 0 makes it a no-op term in plain sums.
const toDouble = (input, onMissing) => ({
  $convert: { input, to: 'double', onError: onMissing, onNull: onMissing },
});

export function buildStatsPipeline({ group, from, to, app, event }) {
  return [
    {
      $match: {
        receivedAt: { $gte: from, $lt: to },
        ...(app && { app }),
        ...(event && { event: { $regex: '^' + escapeRegex(event) } }),
      },
    },
    {
      $group: {
        _id: { $dateTrunc: { date: '$receivedAt', unit: group } },
        total: { $sum: 1 },
        debug: levelCount('debug'),
        info: levelCount('info'),
        warn: levelCount('warn'),
        error: levelCount('error'),
        latencyP: {
          $percentile: {
            input: toDouble({ $ifNull: ['$data.latencyMs', '$data.durationMs'] }, null),
            p: [0.5, 0.95, 0.99],
            method: 'approximate',
          },
        },
        statusTotal: { $sum: { $cond: [{ $ne: [toDouble('$data.status', null), null] }, 1, 0] } },
        statusErrors: { $sum: { $cond: [{ $gte: [toDouble('$data.status', null), 400] }, 1, 0] } },
        costUsd: { $sum: toDouble('$data.costUsd', 0) },
        inputTokens: { $sum: toDouble('$data.inputTokens', 0) },
        outputTokens: { $sum: toDouble('$data.outputTokens', 0) },
      },
    },
    { $sort: { _id: 1 } },
  ];
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

export async function runStats(collection, value) {
  const rows = await collection.aggregate(buildStatsPipeline(value)).toArray();
  const buckets = rows.map((row) => {
    // No numeric latency inputs in a bucket ⇒ fake collection yields [null,null,null],
    // real $percentile may yield bare null — both mean "no latency data".
    const lp = row.latencyP ?? [null, null, null];
    return {
      bucket: new Date(row._id).toISOString(),
      total: row.total,
      counts: { debug: row.debug, info: row.info, warn: row.warn, error: row.error },
      latency: lp[0] == null ? null : { p50: lp[0], p95: lp[1], p99: lp[2] },
      errorRate: row.statusTotal ? row.statusErrors / row.statusTotal : null,
      costUsd: round6(row.costUsd),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
    };
  });
  return { group: value.group, from: value.from.toISOString(), to: value.to.toISOString(), buckets };
}
