// Task S1 (contract C-S1): /v1/facets param parsing, exact $objectToArray/$facet
// pipeline shape, and post-processing of the windowed key discovery.
//
// The in-memory fake collection (test/helpers/fake-collection.js) does not
// implement $project/$map/$objectToArray/$unwind/$facet, so runFacets is driven
// here against small inline stubs that return the canned $facet shape; the
// real-Mongo end-to-end case is added in Task S3.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseFacetsQuery, buildFacetsPipeline, runFacets } from '../src/query/facets.js';

const sp = (qs) => new URLSearchParams(qs);
const D = (iso) => new Date(iso);
const DAY_MS = 24 * 60 * 60 * 1000;

describe('parseFacetsQuery', () => {
  it('defaults to a 24h window ending now, with no app', () => {
    const before = Date.now();
    const res = parseFacetsQuery(sp(''));
    const after = Date.now();
    assert.equal(res.ok, true);
    assert.ok(res.value.to instanceof Date);
    assert.ok(res.value.from instanceof Date);
    assert.ok(res.value.to.getTime() >= before && res.value.to.getTime() <= after);
    assert.equal(res.value.to.getTime() - res.value.from.getTime(), DAY_MS);
    assert.ok(!('app' in res.value));
  });

  it('parses ISO from/to exactly', () => {
    const res = parseFacetsQuery(sp('from=2026-06-10T00:00:00.000Z&to=2026-06-11T00:00:00.000Z'));
    assert.equal(res.ok, true);
    assert.equal(res.value.from.toISOString(), '2026-06-10T00:00:00.000Z');
    assert.equal(res.value.to.toISOString(), '2026-06-11T00:00:00.000Z');
  });

  it('parses epoch-ms digit from/to', () => {
    const fromMs = Date.parse('2026-06-10T12:00:00.000Z');
    const toMs = fromMs + 3_600_000;
    const res = parseFacetsQuery(sp(`from=${fromMs}&to=${toMs}`));
    assert.equal(res.ok, true);
    assert.equal(res.value.from.getTime(), fromMs);
    assert.equal(res.value.to.getTime(), toMs);
  });

  it('defaults from to to-24h when only to is given', () => {
    const res = parseFacetsQuery(sp('to=2026-06-11T00:00:00.000Z'));
    assert.equal(res.ok, true);
    assert.equal(res.value.from.toISOString(), '2026-06-10T00:00:00.000Z');
    assert.equal(res.value.to.toISOString(), '2026-06-11T00:00:00.000Z');
  });

  it('captures the app filter when present', () => {
    const res = parseFacetsQuery(sp('app=dash'));
    assert.equal(res.ok, true);
    assert.equal(res.value.app, 'dash');
  });

  it('does not set app for an empty app value', () => {
    const res = parseFacetsQuery(sp('app='));
    assert.equal(res.ok, true);
    assert.ok(!('app' in res.value));
  });

  it('rejects unparseable dates', () => {
    assert.equal(parseFacetsQuery(sp('from=not-a-date')).ok, false);
    assert.equal(parseFacetsQuery(sp('to=2026-13-99')).ok, false);
  });

  it('rejects unknown parameters, naming the offender', () => {
    const res = parseFacetsQuery(sp('app=dash&foo=1'));
    assert.equal(res.ok, false);
    assert.match(res.error, /foo/);
  });
});

describe('buildFacetsPipeline', () => {
  const from = D('2026-06-10T00:00:00.000Z');
  const to = D('2026-06-11T00:00:00.000Z');

  // Expected stages written out longhand from C-S1 — this IS the contract
  // snapshot, deliberately not sharing helpers with the implementation.
  const projectStage = {
    $project: {
      ik: { $map: { input: { $objectToArray: { $ifNull: ['$ids', {}] } }, as: 'k', in: '$$k.k' } },
      dk: { $map: { input: { $objectToArray: { $ifNull: ['$data', {}] } }, as: 'k', in: '$$k.k' } },
    },
  };
  const facetStage = {
    $facet: {
      ids: [{ $unwind: '$ik' }, { $group: { _id: '$ik' } }],
      data: [{ $unwind: '$dk' }, { $group: { _id: '$dk' } }],
    },
  };

  it('emits the exact C-S1 pipeline with an app match', () => {
    const pipeline = buildFacetsPipeline({ from, to, app: 'dash' });
    assert.deepStrictEqual(pipeline, [
      { $match: { receivedAt: { $gte: from, $lt: to }, app: 'dash' } },
      projectStage,
      facetStage,
    ]);
  });

  it('omits the app match clause when absent', () => {
    const pipeline = buildFacetsPipeline({ from, to });
    assert.deepStrictEqual(pipeline, [
      { $match: { receivedAt: { $gte: from, $lt: to } } },
      projectStage,
      facetStage,
    ]);
  });
});

describe('runFacets', () => {
  const from = D('2026-06-10T00:00:00.000Z');
  const to = D('2026-06-11T00:00:00.000Z');

  // Inline stub mimicking the single-document $facet output Mongo returns:
  // [{ ids:[{_id:key}...], data:[{_id:path}...] }]. Keys arrive unsorted to
  // prove runFacets sorts ascending.
  function stubCollection(facetDoc) {
    const calls = [];
    return {
      calls,
      aggregate(pipeline, opts) {
        calls.push({ pipeline, opts });
        return { async toArray() { return [facetDoc]; } };
      },
    };
  }

  it('returns sorted idsKeys + dataPaths and the window as ISO strings', async () => {
    const col = stubCollection({
      ids: [{ _id: 'userEmail' }, { _id: 'requestId' }],
      data: [{ _id: 'status' }, { _id: 'latencyMs' }, { _id: 'model' }],
    });
    const out = await runFacets(col, { from, to });
    assert.deepEqual(out, {
      window: { from: '2026-06-10T00:00:00.000Z', to: '2026-06-11T00:00:00.000Z' },
      idsKeys: ['requestId', 'userEmail'],
      dataPaths: ['latencyMs', 'model', 'status'],
    });
  });

  it('feeds the C-S1 pipeline (incl. the app match) to aggregate', async () => {
    const col = stubCollection({ ids: [], data: [] });
    await runFacets(col, { from, to, app: 'dash' });
    assert.deepStrictEqual(col.calls[0].pipeline, buildFacetsPipeline({ from, to, app: 'dash' }));
  });

  it('returns empty key arrays when the window has no documents', async () => {
    const col = stubCollection({ ids: [], data: [] });
    const out = await runFacets(col, { from, to });
    assert.deepEqual(out.idsKeys, []);
    assert.deepEqual(out.dataPaths, []);
  });

  it('tolerates a missing $facet result document (empty collection)', async () => {
    const col = {
      aggregate() {
        return { async toArray() { return []; } };
      },
    };
    const out = await runFacets(col, { from, to });
    assert.deepEqual(out.idsKeys, []);
    assert.deepEqual(out.dataPaths, []);
  });

  it('passes maxTimeMS to aggregate when set, omits it otherwise', async () => {
    const col = stubCollection({ ids: [], data: [] });
    await runFacets(col, { from, to }, { maxTimeMS: 5000 });
    await runFacets(col, { from, to }, { maxTimeMS: 0 }); // 0 disables → no opts
    await runFacets(col, { from, to });
    assert.deepEqual(col.calls[0].opts, { maxTimeMS: 5000 });
    assert.equal(col.calls[1].opts, undefined);
    assert.equal(col.calls[2].opts, undefined);
  });
});
