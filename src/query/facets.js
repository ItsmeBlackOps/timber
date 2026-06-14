// GET /v1/facets backend (contract C-S1): discover which ids.* keys and data.*
// paths actually occur in a time window, so the Console can offer a live "find
// by" key picker without a fixed schema. Mirrors the parse*/build*/run* shape of
// src/query/stats.js.

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

  const value = { from, to };
  const app = searchParams.get('app');
  if (app) value.app = app;
  return { ok: true, value };
}

// $objectToArray turns each doc's `ids`/`data` sub-object into [{k,v}], $map
// projects just the keys, then $facet unwinds + de-duplicates each set in a
// single pass. $ifNull guards docs missing the field entirely.
const keyMap = (field) => ({
  $map: { input: { $objectToArray: { $ifNull: [field, {}] } }, as: 'k', in: '$$k.k' },
});

export function buildFacetsPipeline({ from, to, app }) {
  return [
    {
      $match: {
        receivedAt: { $gte: from, $lt: to },
        ...(app && { app }),
      },
    },
    { $project: { ik: keyMap('$ids'), dk: keyMap('$data') } },
    {
      $facet: {
        ids: [{ $unwind: '$ik' }, { $group: { _id: '$ik' } }],
        data: [{ $unwind: '$dk' }, { $group: { _id: '$dk' } }],
      },
    },
  ];
}

const sortedIds = (rows) => (rows ?? []).map((r) => r._id).sort();

export async function runFacets(collection, value, { maxTimeMS } = {}) {
  // maxTimeMS caps the unindexed window scan server-side (defense-in-depth, same
  // as runStats/runLogsQuery); 0/absent leaves it uncapped.
  const opts = Number.isFinite(maxTimeMS) && maxTimeMS > 0 ? { maxTimeMS } : undefined;
  const rows = await collection.aggregate(buildFacetsPipeline(value), opts).toArray();
  // $facet always yields exactly one document; an empty collection can yield
  // none, so default to empty key sets.
  const facet = rows[0] ?? { ids: [], data: [] };
  return {
    window: { from: value.from.toISOString(), to: value.to.toISOString() },
    idsKeys: sortedIds(facet.ids),
    dataPaths: sortedIds(facet.data),
  };
}
