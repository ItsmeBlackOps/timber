// Contract C-S2: GET /v1/groupby — required `by` field (BY_RE-validated), the
// logs filter surface reused (NO cursor), $group/$facet pipeline, and runGroupBy
// post-processing into {by,total,groups,otherCount}.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseGroupByQuery, buildGroupByPipeline, runGroupBy } from '../src/query/groupby.js';

const sp = (qs) => new URLSearchParams(qs);
const DAY_MS = 24 * 60 * 60 * 1000;

function assertFail(result, re) {
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, 'string');
  if (re) assert.match(result.error, re);
}

// groupby now applies a mandatory default time window (like facets/stats) so an
// unwindowed full-collection $group can never be the default. Most filter-surface
// assertions don't care about the exact (now-relative) bounds, so split the
// receivedAt clause off and assert the rest exactly.
function splitWindow(filter) {
  const { receivedAt, ...rest } = filter;
  return { receivedAt, rest };
}

describe('parseGroupByQuery — by field (required, BY_RE)', () => {
  test('by is required → 400 when missing', () => {
    assertFail(parseGroupByQuery(sp('')), /by/);
  });

  test('by= empty → invalid by field', () => {
    assertFail(parseGroupByQuery(sp('by=')), /by/);
  });

  test('accepts the whitelisted top-level fields', () => {
    for (const by of ['app', 'env', 'level', 'event']) {
      const r = parseGroupByQuery(sp(`by=${by}`));
      assert.equal(r.ok, true, r.error);
      assert.equal(r.value.by, by);
    }
  });

  test('accepts dotted ids.<key> and data.<path>', () => {
    assert.equal(parseGroupByQuery(sp('by=ids.userEmail')).value.by, 'ids.userEmail');
    assert.equal(parseGroupByQuery(sp('by=data.model')).value.by, 'data.model');
    assert.equal(parseGroupByQuery(sp('by=data.http.status')).value.by, 'data.http.status');
    assert.equal(parseGroupByQuery(sp('by=ids.request-id')).value.by, 'ids.request-id');
  });

  test('rejects injection / non-whitelisted by fields', () => {
    for (const by of ['message', 'receivedAt', '_id', '$where', 'data', 'ids', 'ids.', 'data.', 'foo.bar', 'data.a$b', 'app;drop']) {
      assertFail(parseGroupByQuery(sp(`by=${encodeURIComponent(by)}`)), /by/);
    }
  });
});

describe('parseGroupByQuery — limit', () => {
  test('defaults to 20', () => {
    assert.equal(parseGroupByQuery(sp('by=app')).value.limit, 20);
  });

  test('honors an explicit integer in range', () => {
    assert.equal(parseGroupByQuery(sp('by=app&limit=5')).value.limit, 5);
    assert.equal(parseGroupByQuery(sp('by=app&limit=1')).value.limit, 1);
    assert.equal(parseGroupByQuery(sp('by=app&limit=100')).value.limit, 100);
  });

  test('clamps out-of-range integers to 1..100', () => {
    assert.equal(parseGroupByQuery(sp('by=app&limit=0')).value.limit, 1);
    assert.equal(parseGroupByQuery(sp('by=app&limit=-3')).value.limit, 1);
    assert.equal(parseGroupByQuery(sp('by=app&limit=9999')).value.limit, 100);
  });

  test('rejects a non-integer limit', () => {
    assertFail(parseGroupByQuery(sp('by=app&limit=abc')), /limit/);
    assertFail(parseGroupByQuery(sp('by=app&limit=2.5')), /limit/);
    assertFail(parseGroupByQuery(sp('by=app&limit=')), /limit/);
  });
});

describe('parseGroupByQuery — like', () => {
  test('absent → no like key', () => {
    assert.ok(!('like' in parseGroupByQuery(sp('by=app')).value));
  });

  test('captures a like string', () => {
    assert.equal(parseGroupByQuery(sp('by=app&like=prod')).value.like, 'prod');
  });

  test('accepts a like of exactly 128 chars', () => {
    const like = 'a'.repeat(128);
    const r = parseGroupByQuery(new URLSearchParams({ by: 'app', like }));
    assert.equal(r.ok, true, r.error);
    assert.equal(r.value.like, like);
  });

  test('rejects a like longer than 128 chars', () => {
    assertFail(parseGroupByQuery(new URLSearchParams({ by: 'app', like: 'a'.repeat(129) })), /like/);
  });
});

describe('parseGroupByQuery — reuses the logs filter surface (NO cursor)', () => {
  test('app/env/level/event map exactly like logs (alongside the default window)', () => {
    const r = parseGroupByQuery(sp('by=ids.userEmail&app=dash&env=prod&level=info,error&event=ai.'));
    assert.equal(r.ok, true, r.error);
    const { rest } = splitWindow(r.value.filter);
    assert.deepEqual(rest, {
      app: 'dash',
      env: 'prod',
      level: { $in: ['info', 'error'] },
      event: { $regex: '^ai\\.' },
    });
  });

  test('explicit from/to → exact receivedAt range (no default applied)', () => {
    const r = parseGroupByQuery(sp('by=app&from=2026-06-11T09:00:00.000Z&to=2026-06-11T10:00:00.000Z'));
    assert.deepEqual(r.value.filter, {
      receivedAt: {
        $gte: new Date('2026-06-11T09:00:00.000Z'),
        $lt: new Date('2026-06-11T10:00:00.000Z'),
      },
    });
  });

  test('an inverted window (from > to) is a 400, not a silent total:0', () => {
    const r = parseGroupByQuery(sp('by=app&from=2026-06-18T00:00:00Z&to=2026-06-17T00:00:00Z'));
    assertFail(r, /from/);
  });

  test('ids.<key> and data.<path> (eq, numeric $in, range) reuse logs semantics', () => {
    assert.deepEqual(splitWindow(parseGroupByQuery(sp('by=app&ids.requestId=r-42')).value.filter).rest, {
      'ids.requestId': 'r-42',
    });
    assert.deepEqual(splitWindow(parseGroupByQuery(sp('by=app&data.latencyMs=42')).value.filter).rest, {
      'data.latencyMs': { $in: [42, '42'] },
    });
    assert.deepEqual(splitWindow(parseGroupByQuery(sp('by=app&data.latencyMs__gte=100&data.latencyMs__lte=500')).value.filter).rest, {
      'data.latencyMs': { $gte: 100, $lte: 500 },
    });
  });

  test('q maps to a message regex (and the ReDoS guard still applies)', () => {
    assert.deepEqual(splitWindow(parseGroupByQuery(sp('by=app&q=slow query')).value.filter).rest, {
      message: { $regex: 'slow query', $options: 'i' },
    });
    assertFail(parseGroupByQuery(new URLSearchParams({ by: 'app', q: '(a+)+$' })), /q /);
  });

  // SECURITY (major DoS): groupby with only `by` and no from/to MUST NOT scan the
  // entire retained collection. Like facets/stats, parseGroupByQuery defaults to a
  // bounded 24h window so the unbounded sender-keyed $group runs over a bounded set.
  test('defaults to a 24h window ending now when from/to are omitted (no unwindowed scan)', () => {
    const before = Date.now();
    const r = parseGroupByQuery(sp('by=ids.requestId'));
    const after = Date.now();
    assert.equal(r.ok, true, r.error);
    const { receivedAt } = splitWindow(r.value.filter);
    assert.ok(receivedAt, 'a default receivedAt window must be present');
    assert.ok(receivedAt.$gte instanceof Date && receivedAt.$lt instanceof Date);
    assert.ok(receivedAt.$lt.getTime() >= before && receivedAt.$lt.getTime() <= after, 'to defaults to now');
    assert.equal(receivedAt.$lt.getTime() - receivedAt.$gte.getTime(), DAY_MS, 'window spans 24h');
    // resolved window is also surfaced on value for the response echo
    assert.ok(r.value.from instanceof Date && r.value.to instanceof Date);
    assert.equal(r.value.from.getTime(), receivedAt.$gte.getTime());
    assert.equal(r.value.to.getTime(), receivedAt.$lt.getTime());
  });

  test('defaults from to to-24h when only to is given', () => {
    const r = parseGroupByQuery(sp('by=ids.requestId&to=2026-06-11T00:00:00.000Z'));
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(r.value.filter.receivedAt, {
      $gte: new Date('2026-06-10T00:00:00.000Z'),
      $lt: new Date('2026-06-11T00:00:00.000Z'),
    });
  });

  test('an explicit `from` alone keeps `to` defaulting to now (window stays bounded below)', () => {
    const before = Date.now();
    const r = parseGroupByQuery(sp('by=app&from=2026-06-01T00:00:00.000Z'));
    const after = Date.now();
    assert.equal(r.ok, true, r.error);
    assert.equal(r.value.filter.receivedAt.$gte.getTime(), new Date('2026-06-01T00:00:00.000Z').getTime());
    assert.ok(r.value.filter.receivedAt.$lt.getTime() >= before && r.value.filter.receivedAt.$lt.getTime() <= after);
  });

  test('a cursor param does not produce a keyset $or (NO cursor)', () => {
    const r = parseGroupByQuery(sp('by=app&cursor=whatever'));
    assert.equal(r.ok, true, r.error);
    assert.ok(!('$or' in r.value.filter), 'groupby must not honor cursor');
  });

  test('rejects an unknown filter param, naming it', () => {
    assertFail(parseGroupByQuery(sp('by=app&foo=1')), /foo/);
  });
});

describe('buildGroupByPipeline — exact C-S2 shape', () => {
  test('without like: $match → $group → $facet(groups,totals)', () => {
    const filter = { app: 'dash', level: { $in: ['error'] } };
    const pipeline = buildGroupByPipeline({ by: 'ids.userEmail', filter, limit: 20 });
    assert.deepStrictEqual(pipeline, [
      { $match: filter },
      { $group: { _id: '$ids.userEmail', count: { $sum: 1 } } },
      {
        $facet: {
          groups: [{ $sort: { count: -1, _id: 1 } }, { $limit: 20 }],
          totals: [{ $group: { _id: null, total: { $sum: '$count' } } }],
        },
      },
    ]);
  });

  test('with like: inserts a $regex $match on _id before the $facet (escaped)', () => {
    const pipeline = buildGroupByPipeline({ by: 'app', filter: {}, limit: 10, like: 'a.b+' });
    assert.deepStrictEqual(pipeline, [
      { $match: {} },
      { $group: { _id: '$app', count: { $sum: 1 } } },
      { $match: { _id: { $regex: 'a\\.b\\+', $options: 'i' } } },
      {
        $facet: {
          groups: [{ $sort: { count: -1, _id: 1 } }, { $limit: 10 }],
          totals: [{ $group: { _id: null, total: { $sum: '$count' } } }],
        },
      },
    ]);
  });

  test('limit flows into the $facet groups $limit stage', () => {
    const pipeline = buildGroupByPipeline({ by: 'level', filter: {}, limit: 3 });
    assert.deepStrictEqual(pipeline[2].$facet.groups, [{ $sort: { count: -1, _id: 1 } }, { $limit: 3 }]);
  });
});

describe('runGroupBy — post-processing of $facet output', () => {
  // Stub the driver the way query-events.test.js does: assert what runGroupBy
  // sends to aggregate and how it folds the single $facet result document.
  function stub(facetDoc) {
    const calls = [];
    return {
      calls,
      aggregate(pipeline, opts) {
        calls.push({ pipeline, opts });
        return { async toArray() { return facetDoc === undefined ? [] : [facetDoc]; } };
      },
    };
  }

  test('maps groups _id→value, derives total and a floored otherCount', async () => {
    const col = stub({
      groups: [
        { _id: 'a@x.com', count: 7 },
        { _id: 'b@x.com', count: 3 },
      ],
      totals: [{ _id: null, total: 15 }],
    });
    const out = await runGroupBy(col, { by: 'ids.userEmail', filter: {}, limit: 20 });
    assert.deepEqual(out, {
      by: 'ids.userEmail',
      total: 15,
      groups: [
        { value: 'a@x.com', count: 7 },
        { value: 'b@x.com', count: 3 },
      ],
      otherCount: 5, // 15 - (7 + 3)
    });
  });

  // Spec §5.2: the response echoes the resolved scan window so a client can see
  // (and reproduce) the bounded range a defaulted query actually ran over.
  test('echoes the resolved window as ISO strings when from/to are on the value', async () => {
    const col = stub({ groups: [{ _id: 'web', count: 2 }], totals: [{ _id: null, total: 2 }] });
    const from = new Date('2026-06-10T00:00:00.000Z');
    const to = new Date('2026-06-11T00:00:00.000Z');
    const out = await runGroupBy(col, { by: 'app', filter: { receivedAt: { $gte: from, $lt: to } }, limit: 20, from, to });
    assert.deepEqual(out.window, { from: '2026-06-10T00:00:00.000Z', to: '2026-06-11T00:00:00.000Z' });
    assert.equal(out.by, 'app');
    assert.equal(out.total, 2);
  });

  test('otherCount is 0 when the returned groups already sum to the total', async () => {
    const col = stub({
      groups: [{ _id: 'web', count: 4 }, { _id: 'api', count: 6 }],
      totals: [{ _id: null, total: 10 }],
    });
    const out = await runGroupBy(col, { by: 'app', filter: {}, limit: 20 });
    assert.equal(out.otherCount, 0);
  });

  test('null group key is preserved as value:null', async () => {
    const col = stub({
      groups: [{ _id: null, count: 2 }],
      totals: [{ _id: null, total: 2 }],
    });
    const out = await runGroupBy(col, { by: 'data.model', filter: {}, limit: 20 });
    assert.deepEqual(out.groups, [{ value: null, count: 2 }]);
    assert.equal(out.otherCount, 0);
  });

  test('numeric and boolean group keys pass through unchanged', async () => {
    const col = stub({
      groups: [{ _id: 200, count: 5 }, { _id: false, count: 1 }],
      totals: [{ _id: null, total: 6 }],
    });
    const out = await runGroupBy(col, { by: 'data.status', filter: {}, limit: 20 });
    assert.deepEqual(out.groups, [{ value: 200, count: 5 }, { value: false, count: 1 }]);
  });

  test('empty match → total 0, no groups, otherCount 0 (totals facet empty)', async () => {
    const col = stub({ groups: [], totals: [] });
    const out = await runGroupBy(col, { by: 'app', filter: { app: 'nope' }, limit: 20 });
    assert.deepEqual(out, { by: 'app', total: 0, groups: [], otherCount: 0 });
  });

  test('a never-matching pipeline yielding no facet document also yields total 0', async () => {
    const col = stub(undefined); // aggregate returns []
    const out = await runGroupBy(col, { by: 'app', filter: {}, limit: 20 });
    assert.deepEqual(out, { by: 'app', total: 0, groups: [], otherCount: 0 });
  });

  test('sends the built pipeline to aggregate', async () => {
    const col = stub({ groups: [], totals: [] });
    await runGroupBy(col, { by: 'app', filter: { env: 'prod' }, limit: 7, like: 'x' });
    assert.deepStrictEqual(col.calls[0].pipeline, buildGroupByPipeline({ by: 'app', filter: { env: 'prod' }, limit: 7, like: 'x' }));
  });

  test('passes maxTimeMS to aggregate when positive, omits it otherwise', async () => {
    const col = stub({ groups: [], totals: [] });
    await runGroupBy(col, { by: 'app', filter: {}, limit: 20 }, { maxTimeMS: 5000 });
    await runGroupBy(col, { by: 'app', filter: {}, limit: 20 }, { maxTimeMS: 0 });
    await runGroupBy(col, { by: 'app', filter: {}, limit: 20 });
    assert.deepEqual(col.calls[0].opts, { maxTimeMS: 5000 });
    assert.equal(col.calls[1].opts, undefined);
    assert.equal(col.calls[2].opts, undefined);
  });
});
