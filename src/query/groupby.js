// Contract C-S2: GET /v1/groupby — count documents grouped by a single field,
// over the same filter surface as /v1/logs. Returns the top-N groups by count
// plus an `otherCount` rollup of everything past the limit, so a UI can render
// "errors by user" / "volume by service" bars with an honest remainder.

import { buildLogsFilter } from './logs.js';

// Whitelist of groupable fields. Anchored + restricted to known top-level keys
// and dotted ids.*/data.* paths whose segments are [\w.-] only — so a `by`
// value can never smuggle a `$` operator or other Mongo-injection payload into
// the `$group` `_id` expression.
const BY_RE = /^(app|env|level|event|ids\.[\w.-]+|data\.[\w.-]+)$/;

const MAX_LIKE_CHARS = 128;
const INT_RE = /^-?\d+$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (error) => ({ ok: false, error });
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Same date parsing as facets/stats: ISO-8601 string or epoch-ms digits.
const parseDate = (raw) => {
  const d = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

// groupby's own knobs; everything else is a logs filter param forwarded to the
// shared builder. `cursor` is dropped here (not forwarded): groupby has no
// pagination, so it must never turn into a keyset $or (contract: "NO cursor").
const OWN_PARAMS = new Set(['by', 'limit', 'like', 'cursor']);

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

  // SECURITY (resource-exhaustion / query-denial DoS): groupby's $group key is
  // sender-chosen and uncapped (by=ids.requestId etc.), and ids.*/data.* keys are
  // unindexed (PRD §7.4). Without a bounded window an unwindowed `by=ids.requestId`
  // would $group over the ENTIRE retained collection (debug 7d … error 90d) —
  // maxTimeMS bounds TIME, not the per-distinct-value $group/$sort memory, so a
  // no-disk Mongo 400s (code 292) and a disk-enabled one COLLSCAN-spills to disk.
  // So, exactly like facets+stats (and per spec §5.2 "time-windowed, default last
  // 24h"), DEFAULT a 24h window: to = now, from = to − 24h. Each side defaults
  // independently; an explicit value is preserved. The resolved window is fed back
  // through the shared builder (canonical epoch-ms) so format + inverted-window
  // (from ≥ to) validation and the receivedAt clause are all produced in one place.
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

  // Reuse the logs filter surface verbatim (app/env/level/event/q/ids.*/data.*),
  // minus groupby's own params; from/to are replaced by the resolved window above.
  // Any unknown param still 400s because buildLogsFilter rejects it.
  const filterParams = new URLSearchParams();
  for (const [name, value] of params) {
    if (!OWN_PARAMS.has(name) && name !== 'from' && name !== 'to') filterParams.append(name, value);
  }
  filterParams.set('from', String(from.getTime()));
  filterParams.set('to', String(to.getTime()));
  const built = buildLogsFilter(filterParams);
  if (!built.ok) return built; // surfaces the shared inverted-window 400 for from ≥ to

  const value = { by, filter: built.value.filter, limit, from, to };
  if (like !== undefined) value.like = like;
  return { ok: true, value };
}

export function buildGroupByPipeline({ by, filter, limit, like }) {
  return [
    { $match: filter },
    { $group: { _id: '$' + by, count: { $sum: 1 } } },
    // `like` filters the grouped values themselves (autocomplete on the _id),
    // applied AFTER grouping so it matches distinct values, not raw docs.
    ...(like ? [{ $match: { _id: { $regex: escapeRegex(like), $options: 'i' } } }] : []),
    {
      $facet: {
        // groups: the visible top-N by count (ties broken by value asc).
        groups: [{ $sort: { count: -1, _id: 1 } }, { $limit: limit }],
        // totals: the grand total across ALL groups, so otherCount can account
        // for the long tail the $limit dropped.
        totals: [{ $group: { _id: null, total: { $sum: '$count' } } }],
      },
    },
  ];
}

export async function runGroupBy(collection, value, { maxTimeMS } = {}) {
  // maxTimeMS caps the unindexed group scan server-side (defense-in-depth, same
  // as runLogsQuery/runStats); 0/absent leaves it uncapped.
  const opts = Number.isFinite(maxTimeMS) && maxTimeMS > 0 ? { maxTimeMS } : undefined;
  const rows = await collection.aggregate(buildGroupByPipeline(value), opts).toArray();
  // $facet yields a single document: { groups: [...], totals: [...] }. A
  // never-matching pipeline can yield no document at all.
  const facet = rows[0] ?? { groups: [], totals: [] };
  const total = facet.totals?.[0]?.total ?? 0;
  const groups = (facet.groups ?? []).map((g) => ({ value: g._id, count: g.count }));
  const shown = groups.reduce((sum, g) => sum + g.count, 0);
  const otherCount = Math.max(0, total - shown); // floor at 0 against any drift
  const out = { by: value.by, total, groups, otherCount };
  // Echo the resolved scan window (spec §5.2) so a client sees the bounded range a
  // defaulted query ran over. parseGroupByQuery always sets from/to; the key is
  // omitted only when runGroupBy is unit-tested with a bare value (no window).
  if (value.from instanceof Date && value.to instanceof Date) {
    out.window = { from: value.from.toISOString(), to: value.to.toISOString() };
  }
  return out;
}
