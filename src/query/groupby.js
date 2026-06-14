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

const fail = (error) => ({ ok: false, error });
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

  // Reuse the logs filter surface verbatim (app/env/level/event/from/to/q/
  // ids.*/data.*), minus groupby's own params. Any unknown param still 400s
  // because buildLogsFilter rejects it.
  const filterParams = new URLSearchParams();
  for (const [name, value] of params) {
    if (!OWN_PARAMS.has(name)) filterParams.append(name, value);
  }
  const built = buildLogsFilter(filterParams);
  if (!built.ok) return built;

  const value = { by, filter: built.value.filter, limit };
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
  return { by: value.by, total, groups, otherCount };
}
