import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeCollection } from './helpers/fake-collection.js';

const T = (s) => new Date(s);

async function seeded() {
  const fc = createFakeCollection();
  await fc.insertMany([
    {
      _id: '01', app: 'web', env: 'prod', level: 'info', event: 'checkout.start',
      message: 'Order placed', receivedAt: T('2026-06-11T10:00:00.000Z'),
      ids: { requestId: 'r1' }, data: { status: 200, latencyMs: 50 },
    },
    {
      _id: '02', app: 'web', env: 'prod', level: 'error', event: 'checkout.fail',
      message: 'payment DECLINED', receivedAt: T('2026-06-11T10:05:00.000Z'),
      ids: { requestId: 'r2' }, data: { status: 500, latencyMs: 120 },
    },
    {
      _id: '03', app: 'api', env: 'dev', level: 'warn', event: 'db.slow',
      message: 'slow query', receivedAt: T('2026-06-11T11:00:00.000Z'),
      data: { status: '503', durationMs: 300 },
    },
    {
      _id: '04', app: 'api', env: 'prod', level: 'debug', event: 'cache.miss',
      receivedAt: T('2026-06-11T11:30:00.000Z'),
      data: { hit: false, costUsd: 0.5 },
    },
  ]);
  return fc;
}

async function idsOf(cursor) {
  return (await cursor.toArray()).map((d) => d._id);
}

describe('insertMany', () => {
  test('inserts docs, returns insertedCount, exposes raw docs array', async () => {
    const fc = createFakeCollection();
    const res = await fc.insertMany([{ _id: 'a' }, { _id: 'b' }]);
    assert.equal(res.acknowledged, true);
    assert.equal(res.insertedCount, 2);
    assert.ok(Array.isArray(fc.docs));
    assert.deepEqual(fc.docs.map((d) => d._id), ['a', 'b']);
  });

  test('deep-copies on insert: mutating the source object does not corrupt the store', async () => {
    const fc = createFakeCollection();
    const src = { _id: 'a', data: { nested: { v: 1 } } };
    await fc.insertMany([src]);
    src.data.nested.v = 999;
    src.data.extra = 'x';
    assert.equal(fc.docs[0].data.nested.v, 1);
    assert.equal(fc.docs[0].data.extra, undefined);
  });

  test('duplicate _id against stored docs with ordered:false: inserts non-dupes then throws C12 shape', async () => {
    const fc = createFakeCollection();
    await fc.insertMany([{ _id: 'a' }, { _id: 'b' }]);
    await assert.rejects(
      fc.insertMany([{ _id: 'c' }, { _id: 'a' }, { _id: 'd' }], { ordered: false }),
      (err) => {
        assert.equal(err.code, 11000);
        assert.deepEqual(err.writeErrors, [{ code: 11000, index: 1 }]);
        assert.deepEqual(err.result, { insertedCount: 2 });
        return true;
      },
    );
    assert.deepEqual(fc.docs.map((d) => d._id), ['a', 'b', 'c', 'd']);
  });

  test('duplicate _id within the same batch is detected', async () => {
    const fc = createFakeCollection();
    await assert.rejects(
      fc.insertMany([{ _id: 'x', n: 1 }, { _id: 'x', n: 2 }], { ordered: false }),
      (err) => {
        assert.equal(err.code, 11000);
        assert.deepEqual(err.writeErrors, [{ code: 11000, index: 1 }]);
        assert.deepEqual(err.result, { insertedCount: 1 });
        return true;
      },
    );
    assert.equal(fc.docs.length, 1);
    assert.equal(fc.docs[0].n, 1);
  });

  test('all duplicates: every doc errored, insertedCount 0 (flusher replay case)', async () => {
    const fc = createFakeCollection();
    await fc.insertMany([{ _id: 'a' }, { _id: 'b' }]);
    await assert.rejects(
      fc.insertMany([{ _id: 'a' }, { _id: 'b' }], { ordered: false }),
      (err) => {
        assert.equal(err.code, 11000);
        assert.deepEqual(err.writeErrors, [
          { code: 11000, index: 0 },
          { code: 11000, index: 1 },
        ]);
        assert.deepEqual(err.result, { insertedCount: 0 });
        return true;
      },
    );
    assert.equal(fc.docs.length, 2);
  });

  test('duplicate detection sees docs seeded directly via the raw docs array', async () => {
    const fc = createFakeCollection();
    fc.docs.push({ _id: 'seeded' });
    await assert.rejects(
      fc.insertMany([{ _id: 'seeded' }], { ordered: false }),
      (err) => err.code === 11000,
    );
    assert.equal(fc.docs.length, 1);
  });

  test('assigns an _id when missing', async () => {
    const fc = createFakeCollection();
    await fc.insertMany([{ event: 'e' }]);
    assert.ok(fc.docs[0]._id);
  });
});

describe('find: filter operators', () => {
  test('direct equality on a top-level field', async () => {
    const fc = await seeded();
    assert.deepEqual(await idsOf(fc.find({ app: 'web' })), ['01', '02']);
  });

  test('equality via $eq', async () => {
    const fc = await seeded();
    assert.deepEqual(await idsOf(fc.find({ app: { $eq: 'api' } })), ['03', '04']);
  });

  test('dotted-path equality (ids.<key>)', async () => {
    const fc = await seeded();
    assert.deepEqual(await idsOf(fc.find({ 'ids.requestId': 'r2' })), ['02']);
  });

  test('dotted-path equality with boolean value', async () => {
    const fc = await seeded();
    assert.deepEqual(await idsOf(fc.find({ 'data.hit': false })), ['04']);
  });

  test('direct equality on a Date value', async () => {
    const fc = await seeded();
    assert.deepEqual(await idsOf(fc.find({ receivedAt: T('2026-06-11T11:00:00.000Z') })), ['03']);
  });

  test('$in over levels', async () => {
    const fc = await seeded();
    assert.deepEqual(await idsOf(fc.find({ level: { $in: ['error', 'warn'] } })), ['02', '03']);
  });

  test('$in with mixed number/string (data.<path> coercion shape from C8)', async () => {
    const fc = await seeded();
    assert.deepEqual(await idsOf(fc.find({ 'data.status': { $in: [500, '500'] } })), ['02']);
    assert.deepEqual(await idsOf(fc.find({ 'data.status': { $in: [503, '503'] } })), ['03']);
  });

  test('$regex prefix match on event', async () => {
    const fc = await seeded();
    assert.deepEqual(await idsOf(fc.find({ event: { $regex: '^checkout\\.' } })), ['01', '02']);
  });

  test('$regex with $options i on message', async () => {
    const fc = await seeded();
    assert.deepEqual(await idsOf(fc.find({ message: { $regex: 'declined', $options: 'i' } })), ['02']);
  });

  test('$gte/$lt Date range on receivedAt', async () => {
    const fc = await seeded();
    const filter = {
      receivedAt: { $gte: T('2026-06-11T10:00:00.000Z'), $lt: T('2026-06-11T11:00:00.000Z') },
    };
    assert.deepEqual(await idsOf(fc.find(filter)), ['01', '02']);
  });

  test('$gt and $lte on numbers', async () => {
    const fc = await seeded();
    assert.deepEqual(await idsOf(fc.find({ 'data.latencyMs': { $gt: 50 } })), ['02']);
    assert.deepEqual(await idsOf(fc.find({ 'data.latencyMs': { $lte: 50 } })), ['01']);
  });

  test('range operators are type-bracketed like Mongo: number bound does not match string value', async () => {
    const fc = await seeded();
    // '503' (doc 03) is a string, so {$gte: 400} must not match it
    assert.deepEqual(await idsOf(fc.find({ 'data.status': { $gte: 400 } })), ['02']);
  });

  test('$ne matches non-equal values including docs missing the field', async () => {
    const fc = await seeded();
    assert.deepEqual(await idsOf(fc.find({ 'data.latencyMs': { $ne: 120 } })), ['01', '03', '04']);
  });

  test('$and combines sub-filters', async () => {
    const fc = await seeded();
    assert.deepEqual(await idsOf(fc.find({ $and: [{ app: 'web' }, { level: 'error' }] })), ['02']);
  });

  test('$or keyset cursor predicate (exact C8 shape)', async () => {
    const fc = await seeded();
    const c = { receivedAt: T('2026-06-11T10:05:00.000Z'), id: '02' };
    const filter = {
      $or: [
        { receivedAt: { $lt: c.receivedAt } },
        { receivedAt: c.receivedAt, _id: { $lt: c.id } },
      ],
    };
    assert.deepEqual(await idsOf(fc.find(filter)), ['01']);
  });

  test('empty filter and no-arg find return all docs', async () => {
    const fc = await seeded();
    assert.equal((await fc.find({}).toArray()).length, 4);
    assert.equal((await fc.find().toArray()).length, 4);
  });
});

describe('find: sort and limit', () => {
  test('sort {receivedAt:-1,_id:-1} orders newest first', async () => {
    const fc = await seeded();
    const ids = await idsOf(fc.find({}).sort({ receivedAt: -1, _id: -1 }));
    assert.deepEqual(ids, ['04', '03', '02', '01']);
  });

  test('descending sort tiebreaks by _id when receivedAt is equal', async () => {
    const fc = createFakeCollection();
    const at = T('2026-06-11T10:00:00.000Z');
    await fc.insertMany([
      { _id: 'b', receivedAt: at },
      { _id: 'c', receivedAt: at },
      { _id: 'a', receivedAt: at },
      { _id: 'z', receivedAt: T('2026-06-11T12:00:00.000Z') },
    ]);
    const ids = await idsOf(fc.find({}).sort({ receivedAt: -1, _id: -1 }));
    assert.deepEqual(ids, ['z', 'c', 'b', 'a']);
  });

  test('limit caps results after sort; sort/limit chain returns the cursor', async () => {
    const fc = await seeded();
    const ids = await idsOf(fc.find({}).sort({ receivedAt: -1, _id: -1 }).limit(2));
    assert.deepEqual(ids, ['04', '03']);
  });
});

describe('read isolation', () => {
  test('mutating docs returned by find does not corrupt the store', async () => {
    const fc = await seeded();
    const [row] = await fc.find({ _id: '01' }).toArray();
    row.data.status = 999;
    row.ids.requestId = 'hacked';
    row.receivedAt.setTime(0);
    assert.equal(fc.docs[0].data.status, 200);
    assert.equal(fc.docs[0].ids.requestId, 'r1');
    assert.equal(fc.docs[0].receivedAt.getTime(), T('2026-06-11T10:00:00.000Z').getTime());
  });

  test('mutating docs returned by aggregate does not corrupt the store', async () => {
    const fc = await seeded();
    const rows = await fc.aggregate([{ $match: { _id: '01' } }]).toArray();
    rows[0].data.status = 999;
    assert.equal(fc.docs[0].data.status, 200);
  });
});

describe('countDocuments', () => {
  test('counts matching docs, and all docs without a filter', async () => {
    const fc = await seeded();
    assert.equal(await fc.countDocuments({ app: 'api' }), 2);
    assert.equal(await fc.countDocuments(), 4);
  });
});

describe('aggregate: $group with $dateTrunc', () => {
  test('hour bucketing groups by UTC hour and $sort:{_id:1} orders buckets', async () => {
    const fc = createFakeCollection();
    await fc.insertMany([
      { _id: 'a', receivedAt: T('2026-06-11T10:00:00.000Z') },
      { _id: 'b', receivedAt: T('2026-06-11T10:59:59.999Z') },
      { _id: 'c', receivedAt: T('2026-06-11T11:01:00.000Z') },
    ]);
    const rows = await fc.aggregate([
      { $group: { _id: { $dateTrunc: { date: '$receivedAt', unit: 'hour' } }, total: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    assert.equal(rows.length, 2);
    assert.ok(rows[0]._id instanceof Date);
    assert.equal(rows[0]._id.toISOString(), '2026-06-11T10:00:00.000Z');
    assert.equal(rows[0].total, 2);
    assert.equal(rows[1]._id.toISOString(), '2026-06-11T11:00:00.000Z');
    assert.equal(rows[1].total, 1);
  });

  test('day bucketing truncates to UTC midnight', async () => {
    const fc = createFakeCollection();
    await fc.insertMany([
      { _id: 'a', receivedAt: T('2026-06-10T23:30:00.000Z') },
      { _id: 'b', receivedAt: T('2026-06-11T00:30:00.000Z') },
      { _id: 'c', receivedAt: T('2026-06-11T17:00:00.000Z') },
    ]);
    const rows = await fc.aggregate([
      { $group: { _id: { $dateTrunc: { date: '$receivedAt', unit: 'day' } }, total: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    assert.deepEqual(
      rows.map((r) => [r._id.toISOString(), r.total]),
      [['2026-06-10T00:00:00.000Z', 1], ['2026-06-11T00:00:00.000Z', 2]],
    );
  });
});

describe('aggregate: accumulators and expressions', () => {
  test('$sum with literal and with $sum expression over field paths', async () => {
    const fc = createFakeCollection();
    await fc.insertMany([{ _id: '1', a: 1, b: 2 }, { _id: '2', a: 3 }]);
    const rows = await fc.aggregate([
      { $group: { _id: null, n: { $sum: 1 }, t: { $sum: { $sum: ['$a', '$b'] } } } },
    ]).toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].n, 2);
    assert.equal(rows[0].t, 6);
  });

  test('$percentile uses nearest-rank over numeric inputs', async () => {
    const fc = createFakeCollection();
    const latencies = [60, 10, 90, 30, 100, 20, 80, 40, 70, 50];
    await fc.insertMany(latencies.map((v, i) => ({ _id: `d${i}`, data: { latencyMs: v } })));
    const rows = await fc.aggregate([
      { $group: { _id: null, p: { $percentile: { input: '$data.latencyMs', p: [0.5, 0.95, 0.99], method: 'approximate' } } } },
    ]).toArray();
    assert.deepEqual(rows[0].p, [50, 100, 100]);
  });

  test('$percentile nearest-rank on a small set: p50 of [1,2,3,4] is 2', async () => {
    const fc = createFakeCollection();
    await fc.insertMany([1, 2, 3, 4].map((v, i) => ({ _id: `d${i}`, v })));
    const rows = await fc.aggregate([
      { $group: { _id: null, p: { $percentile: { input: '$v', p: [0.5], method: 'approximate' } } } },
    ]).toArray();
    assert.deepEqual(rows[0].p, [2]);
  });

  test('$percentile with no numeric inputs yields one null per requested p', async () => {
    const fc = createFakeCollection();
    await fc.insertMany([{ _id: 'a' }, { _id: 'b', data: {} }]);
    const rows = await fc.aggregate([
      { $group: { _id: null, p: { $percentile: { input: { $convert: { input: { $ifNull: ['$data.latencyMs', '$data.durationMs'] }, to: 'double', onError: null, onNull: null } }, p: [0.5, 0.95, 0.99], method: 'approximate' } } } },
    ]).toArray();
    assert.deepEqual(rows[0].p, [null, null, null]);
  });

  test('$convert returns onNull for missing input', async () => {
    const fc = createFakeCollection();
    await fc.insertMany([{ _id: 'a' }]);
    const rows = await fc.aggregate([
      { $group: { _id: null, x: { $sum: { $convert: { input: '$nope', to: 'double', onError: 3, onNull: 7 } } } } },
    ]).toArray();
    assert.equal(rows[0].x, 7);
  });

  test('$convert returns onError for a non-numeric string', async () => {
    const fc = createFakeCollection();
    await fc.insertMany([{ _id: 'a', s: 'not-a-number' }]);
    const rows = await fc.aggregate([
      { $group: { _id: null, x: { $sum: { $convert: { input: '$s', to: 'double', onError: 3, onNull: 7 } } } } },
    ]).toArray();
    assert.equal(rows[0].x, 3);
  });

  test('$convert parses numeric strings to double', async () => {
    const fc = createFakeCollection();
    await fc.insertMany([{ _id: 'a', s: '12.5' }]);
    const rows = await fc.aggregate([
      { $group: { _id: null, x: { $sum: { $convert: { input: '$s', to: 'double', onError: 0, onNull: 0 } } } } },
    ]).toArray();
    assert.equal(rows[0].x, 12.5);
  });
});

describe('aggregate: exact C9 stats group stage', () => {
  test('level counts, latency percentiles with $ifNull fallback, status error rate inputs, cost and token sums', async () => {
    const fc = createFakeCollection();
    await fc.insertMany([
      { _id: 'A', level: 'info', receivedAt: T('2026-06-11T10:10:00.000Z'), data: { latencyMs: 100, status: 200, costUsd: 0.000001, inputTokens: 10, outputTokens: 5 } },
      { _id: 'B', level: 'error', receivedAt: T('2026-06-11T10:20:00.000Z'), data: { durationMs: 300, status: 500 } },
      { _id: 'C', level: 'debug', receivedAt: T('2026-06-11T10:30:00.000Z'), data: { status: 'abc' } },
      { _id: 'D', level: 'info', receivedAt: T('2026-06-11T10:40:00.000Z') },
      { _id: 'E', level: 'warn', receivedAt: T('2026-06-11T11:15:00.000Z'), data: { latencyMs: 50, status: '404' } },
      { _id: 'X', level: 'info', receivedAt: T('2026-06-11T09:59:59.000Z') }, // outside window
    ]);
    const from = T('2026-06-11T10:00:00.000Z');
    const to = T('2026-06-11T12:00:00.000Z');
    const statusToDouble = { $convert: { input: '$data.status', to: 'double', onError: null, onNull: null } };
    const rows = await fc.aggregate([
      { $match: { receivedAt: { $gte: from, $lt: to } } },
      { $group: {
        _id: { $dateTrunc: { date: '$receivedAt', unit: 'hour' } },
        total: { $sum: 1 },
        debug: { $sum: { $cond: [{ $eq: ['$level', 'debug'] }, 1, 0] } },
        info: { $sum: { $cond: [{ $eq: ['$level', 'info'] }, 1, 0] } },
        warn: { $sum: { $cond: [{ $eq: ['$level', 'warn'] }, 1, 0] } },
        error: { $sum: { $cond: [{ $eq: ['$level', 'error'] }, 1, 0] } },
        latencyP: { $percentile: { input: { $convert: { input: { $ifNull: ['$data.latencyMs', '$data.durationMs'] }, to: 'double', onError: null, onNull: null } }, p: [0.5, 0.95, 0.99], method: 'approximate' } },
        statusTotal: { $sum: { $cond: [{ $ne: [statusToDouble, null] }, 1, 0] } },
        statusErrors: { $sum: { $cond: [{ $gte: [statusToDouble, 400] }, 1, 0] } },
        costUsd: { $sum: { $convert: { input: '$data.costUsd', to: 'double', onError: 0, onNull: 0 } } },
        inputTokens: { $sum: { $convert: { input: '$data.inputTokens', to: 'double', onError: 0, onNull: 0 } } },
        outputTokens: { $sum: { $convert: { input: '$data.outputTokens', to: 'double', onError: 0, onNull: 0 } } },
      } },
      { $sort: { _id: 1 } },
    ]).toArray();

    assert.equal(rows.length, 2);
    const [h10, h11] = rows;
    assert.equal(h10._id.toISOString(), '2026-06-11T10:00:00.000Z');
    assert.equal(h10.total, 4);
    assert.deepEqual(
      { debug: h10.debug, info: h10.info, warn: h10.warn, error: h10.error },
      { debug: 1, info: 2, warn: 0, error: 1 },
    );
    assert.deepEqual(h10.latencyP, [100, 300, 300]); // [100,300]: ranks ceil(.5*2)=1, ceil(.95*2)=2, ceil(.99*2)=2
    assert.equal(h10.statusTotal, 2); // 'abc' -> onError null, missing -> onNull null
    assert.equal(h10.statusErrors, 1); // only 500 >= 400; null is below numbers in BSON order
    assert.equal(h10.costUsd, 0.000001);
    assert.equal(h10.inputTokens, 10);
    assert.equal(h10.outputTokens, 5);

    assert.equal(h11._id.toISOString(), '2026-06-11T11:00:00.000Z');
    assert.equal(h11.total, 1);
    assert.equal(h11.warn, 1);
    assert.deepEqual(h11.latencyP, [50, 50, 50]);
    assert.equal(h11.statusTotal, 1); // '404' parses to 404
    assert.equal(h11.statusErrors, 1);
    assert.equal(h11.costUsd, 0);
  });
});

describe('aggregate: exact C10 events pipeline', () => {
  const eventsPipeline = [
    { $group: { _id: { app: '$app', event: '$event' } } },
    { $group: { _id: '$_id.app', events: { $addToSet: '$_id.event' } } },
    { $sort: { _id: 1 } },
  ];

  async function eventsSeed() {
    const fc = createFakeCollection();
    await fc.insertMany([
      { _id: '1', app: 'web', event: 'click' },
      { _id: '2', app: 'api', event: 'ping' },
      { _id: '3', app: 'web', event: 'click' },
      { _id: '4', app: 'web', event: 'view' },
    ]);
    return fc;
  }

  test('groups unique events per app ($addToSet uniqueness) and sorts apps by _id asc', async () => {
    const fc = await eventsSeed();
    const rows = await fc.aggregate(eventsPipeline).toArray();
    assert.deepEqual(rows.map((r) => r._id), ['api', 'web']);
    assert.deepEqual(rows[0].events, ['ping']);
    assert.deepEqual(rows[1].events.slice().sort(), ['click', 'view']);
    assert.equal(rows[1].events.length, 2);
  });

  test('optional $match:{app} stage narrows to one app', async () => {
    const fc = await eventsSeed();
    const rows = await fc.aggregate([{ $match: { app: 'web' } }, ...eventsPipeline]).toArray();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]._id, 'web');
  });
});

describe('index methods', () => {
  test('createIndex and createIndexes resolve without touching data', async () => {
    const fc = await seeded();
    await fc.createIndex({ receivedAt: -1 });
    await fc.createIndexes([
      { key: { app: 1, receivedAt: -1 } },
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
    ]);
    assert.equal(fc.docs.length, 4);
  });
});
