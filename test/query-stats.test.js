// Task 11 (contract C9): /v1/stats param parsing, exact pipeline shape, bucket post-processing.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseStatsQuery, buildStatsPipeline, runStats } from '../src/query/stats.js';
import { createFakeCollection } from './helpers/fake-collection.js';

const sp = (qs) => new URLSearchParams(qs);
const D = (iso) => new Date(iso);
const DAY_MS = 24 * 60 * 60 * 1000;

describe('parseStatsQuery', () => {
  it('defaults to group=hour and a 24h window ending now', () => {
    const before = Date.now();
    const res = parseStatsQuery(sp(''));
    const after = Date.now();
    assert.equal(res.ok, true);
    assert.equal(res.value.group, 'hour');
    assert.ok(res.value.to instanceof Date);
    assert.ok(res.value.from instanceof Date);
    assert.ok(res.value.to.getTime() >= before && res.value.to.getTime() <= after);
    assert.equal(res.value.to.getTime() - res.value.from.getTime(), DAY_MS);
    assert.ok(!('app' in res.value));
    assert.ok(!('event' in res.value));
  });

  it('accepts group=day', () => {
    const res = parseStatsQuery(sp('group=day'));
    assert.equal(res.ok, true);
    assert.equal(res.value.group, 'day');
  });

  it('rejects an invalid group', () => {
    const res = parseStatsQuery(sp('group=minute'));
    assert.equal(res.ok, false);
    assert.equal(typeof res.error, 'string');
    assert.ok(res.error.length > 0);
  });

  it('rejects an empty group value', () => {
    assert.equal(parseStatsQuery(sp('group=')).ok, false);
  });

  it('rejects unknown parameters, naming the offender', () => {
    const res = parseStatsQuery(sp('group=hour&foo=1'));
    assert.equal(res.ok, false);
    assert.match(res.error, /foo/);
  });

  it('parses ISO from/to exactly', () => {
    const res = parseStatsQuery(sp('from=2026-06-10T00:00:00.000Z&to=2026-06-11T00:00:00.000Z'));
    assert.equal(res.ok, true);
    assert.equal(res.value.from.toISOString(), '2026-06-10T00:00:00.000Z');
    assert.equal(res.value.to.toISOString(), '2026-06-11T00:00:00.000Z');
  });

  it('parses epoch-ms digit from/to', () => {
    const fromMs = Date.parse('2026-06-10T12:00:00.000Z');
    const toMs = fromMs + 3_600_000;
    const res = parseStatsQuery(sp(`from=${fromMs}&to=${toMs}`));
    assert.equal(res.ok, true);
    assert.equal(res.value.from.getTime(), fromMs);
    assert.equal(res.value.to.getTime(), toMs);
  });

  it('defaults from to to-24h when only to is given', () => {
    const res = parseStatsQuery(sp('to=2026-06-11T00:00:00.000Z'));
    assert.equal(res.ok, true);
    assert.equal(res.value.from.toISOString(), '2026-06-10T00:00:00.000Z');
    assert.equal(res.value.to.toISOString(), '2026-06-11T00:00:00.000Z');
  });

  it('rejects unparseable dates', () => {
    assert.equal(parseStatsQuery(sp('from=not-a-date')).ok, false);
    assert.equal(parseStatsQuery(sp('to=2026-13-99')).ok, false);
  });

  it('rejects an inverted window (from > to) with a 400', () => {
    const res = parseStatsQuery(sp('from=2026-06-18T00:00:00.000Z&to=2026-06-17T00:00:00.000Z'));
    assert.equal(res.ok, false);
    assert.match(res.error, /from/);
  });

  it('rejects an empty window (from === to) with a 400 ($gte/$lt never overlap)', () => {
    const res = parseStatsQuery(sp('from=2026-06-17T00:00:00.000Z&to=2026-06-17T00:00:00.000Z'));
    assert.equal(res.ok, false);
    assert.match(res.error, /from/);
  });

  it('still accepts the default 24h window and an explicit forward window', () => {
    assert.equal(parseStatsQuery(sp('')).ok, true);
    assert.equal(parseStatsQuery(sp('from=2026-06-17T00:00:00.000Z&to=2026-06-18T00:00:00.000Z')).ok, true);
  });

  it('captures app and event filters', () => {
    const res = parseStatsQuery(sp('app=dash&event=ai.'));
    assert.equal(res.ok, true);
    assert.equal(res.value.app, 'dash');
    assert.equal(res.value.event, 'ai.');
  });
});

describe('buildStatsPipeline', () => {
  const from = D('2026-06-10T00:00:00.000Z');
  const to = D('2026-06-11T00:00:00.000Z');

  // Expected stages written out longhand from C9 — this test IS the contract snapshot,
  // deliberately not sharing builder helpers with the implementation.
  const statusToDouble = { $convert: { input: '$data.status', to: 'double', onError: null, onNull: null } };
  const groupStage = (unit) => ({
    $group: {
      _id: { $dateTrunc: { date: '$receivedAt', unit } },
      total: { $sum: 1 },
      debug: { $sum: { $cond: [{ $eq: ['$level', 'debug'] }, 1, 0] } },
      info: { $sum: { $cond: [{ $eq: ['$level', 'info'] }, 1, 0] } },
      warn: { $sum: { $cond: [{ $eq: ['$level', 'warn'] }, 1, 0] } },
      error: { $sum: { $cond: [{ $eq: ['$level', 'error'] }, 1, 0] } },
      latencyP: {
        $percentile: {
          input: {
            $convert: {
              input: { $ifNull: ['$data.latencyMs', '$data.durationMs'] },
              to: 'double',
              onError: null,
              onNull: null,
            },
          },
          p: [0.5, 0.95, 0.99],
          method: 'approximate',
        },
      },
      statusTotal: { $sum: { $cond: [{ $ne: [statusToDouble, null] }, 1, 0] } },
      statusErrors: { $sum: { $cond: [{ $gte: [statusToDouble, 400] }, 1, 0] } },
      costUsd: { $sum: { $convert: { input: '$data.costUsd', to: 'double', onError: 0, onNull: 0 } } },
      inputTokens: { $sum: { $convert: { input: '$data.inputTokens', to: 'double', onError: 0, onNull: 0 } } },
      outputTokens: { $sum: { $convert: { input: '$data.outputTokens', to: 'double', onError: 0, onNull: 0 } } },
    },
  });

  it('emits the exact C9 pipeline with app and event filters (group=day)', () => {
    const pipeline = buildStatsPipeline({ group: 'day', from, to, app: 'dash', event: 'ai.' });
    assert.deepStrictEqual(pipeline, [
      { $match: { receivedAt: { $gte: from, $lt: to }, app: 'dash', event: { $regex: '^ai\\.' } } },
      groupStage('day'),
      { $sort: { _id: 1 } },
    ]);
  });

  it('omits app/event match clauses when absent (group=hour)', () => {
    const pipeline = buildStatsPipeline({ group: 'hour', from, to });
    assert.deepStrictEqual(pipeline, [
      { $match: { receivedAt: { $gte: from, $lt: to } } },
      groupStage('hour'),
      { $sort: { _id: 1 } },
    ]);
  });

  it('escapes regex metacharacters in the event prefix', () => {
    const [match] = buildStatsPipeline({ group: 'hour', from, to, event: 'a+b(c' });
    assert.deepStrictEqual(match.$match.event, { $regex: '^a\\+b\\(c' });
  });
});

describe('runStats', () => {
  const from = D('2026-06-11T00:00:00.000Z');
  const to = D('2026-06-11T03:00:00.000Z');

  async function seedMain() {
    const col = createFakeCollection();
    await col.insertMany([
      // hour 0 — latencyMs/durationMs mix, numeric + numeric-string status, cost float dust, tokens
      { app: 'dash', event: 'ai.request', level: 'info', receivedAt: D('2026-06-11T00:10:00.000Z'),
        data: { latencyMs: 100, status: 200, costUsd: 0.1, inputTokens: 10, outputTokens: 5 } },
      { app: 'dash', event: 'ai.request', level: 'error', receivedAt: D('2026-06-11T00:59:59.999Z'),
        data: { durationMs: 300, status: '500', costUsd: 0.2, inputTokens: 20, outputTokens: 5 } },
      { app: 'dash', event: 'db.query', level: 'warn', receivedAt: D('2026-06-11T00:00:00.000Z'),
        data: { keysExamined: 7 } },
      { app: 'dash', event: 'cron.run', level: 'debug', receivedAt: D('2026-06-11T00:45:00.000Z') },
      // hour 1 — status-bearing doc but no latency keys anywhere in the bucket
      { app: 'dash', event: 'ai.request', level: 'info', receivedAt: D('2026-06-11T01:00:00.000Z'),
        data: { status: 204 } },
      { app: 'dash', event: 'db.query', level: 'info', receivedAt: D('2026-06-11T01:30:00.000Z') },
      // hour 2 — different app, latency but no status
      { app: 'other', event: 'ai.request', level: 'error', receivedAt: D('2026-06-11T02:15:00.000Z'),
        data: { latencyMs: 50 } },
      // outside the window: just before from, exactly at to ($lt excludes)
      { app: 'dash', event: 'ai.request', level: 'info', receivedAt: D('2026-06-10T23:59:59.999Z'),
        data: { costUsd: 99 } },
      { app: 'dash', event: 'ai.request', level: 'info', receivedAt: D('2026-06-11T03:00:00.000Z'),
        data: { costUsd: 99 } },
    ]);
    return col;
  }

  it('aggregates hourly buckets: boundaries, level counts, percentiles, errorRate, cost, tokens', async () => {
    const col = await seedMain();
    const res = await runStats(col, { group: 'hour', from, to });
    assert.deepStrictEqual(res, {
      group: 'hour',
      from: '2026-06-11T00:00:00.000Z',
      to: '2026-06-11T03:00:00.000Z',
      buckets: [
        {
          bucket: '2026-06-11T00:00:00.000Z',
          total: 4,
          counts: { debug: 1, info: 1, warn: 1, error: 1 },
          // nearest-rank over [100, 300]
          latency: { p50: 100, p95: 300, p99: 300 },
          // 2 of 4 docs carry status; 1 of those is >= 400
          errorRate: 0.5,
          // 0.1 + 0.2 sums to 0.30000000000000004 — proves 6 dp rounding
          costUsd: 0.3,
          inputTokens: 30,
          outputTokens: 10,
        },
        {
          bucket: '2026-06-11T01:00:00.000Z',
          total: 2,
          counts: { debug: 0, info: 2, warn: 0, error: 0 },
          latency: null,
          errorRate: 0,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
        {
          bucket: '2026-06-11T02:00:00.000Z',
          total: 1,
          counts: { debug: 0, info: 0, warn: 0, error: 1 },
          latency: { p50: 50, p95: 50, p99: 50 },
          errorRate: null,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      ],
    });
  });

  async function seedFilter() {
    const col = createFakeCollection();
    await col.insertMany([
      { app: 'dash', event: 'ai.request', level: 'info', receivedAt: D('2026-06-11T00:05:00.000Z'),
        data: { costUsd: 1.2345678 } },
      // decoy: matches '^ai.' only if the dot is NOT escaped
      { app: 'dash', event: 'aixrequest', level: 'info', receivedAt: D('2026-06-11T00:06:00.000Z') },
      { app: 'other', event: 'ai.request', level: 'info', receivedAt: D('2026-06-11T00:07:00.000Z') },
      { app: 'dash', event: 'db.query', level: 'info', receivedAt: D('2026-06-11T01:05:00.000Z') },
    ]);
    return col;
  }

  it('applies the app filter', async () => {
    const col = await seedFilter();
    const res = await runStats(col, { group: 'hour', from, to, app: 'dash' });
    assert.deepStrictEqual(res.buckets.map((b) => [b.bucket, b.total]), [
      ['2026-06-11T00:00:00.000Z', 2],
      ['2026-06-11T01:00:00.000Z', 1],
    ]);
  });

  it('applies the event prefix filter with regex escaping', async () => {
    const col = await seedFilter();
    const res = await runStats(col, { group: 'hour', from, to, event: 'ai.' });
    assert.deepStrictEqual(res.buckets.map((b) => [b.bucket, b.total]), [
      ['2026-06-11T00:00:00.000Z', 2],
    ]);
    assert.equal(res.buckets[0].costUsd, 1.234568);
  });

  it('combines app and event filters', async () => {
    const col = await seedFilter();
    const res = await runStats(col, { group: 'hour', from, to, app: 'dash', event: 'ai.' });
    assert.deepStrictEqual(res.buckets.map((b) => [b.bucket, b.total]), [
      ['2026-06-11T00:00:00.000Z', 1],
    ]);
  });

  it('buckets by UTC day when group=day', async () => {
    const col = createFakeCollection();
    await col.insertMany([
      { app: 'dash', event: 'a', level: 'info', receivedAt: D('2026-06-10T05:00:00.000Z') },
      { app: 'dash', event: 'a', level: 'info', receivedAt: D('2026-06-11T07:00:00.000Z') },
    ]);
    const res = await runStats(col, {
      group: 'day',
      from: D('2026-06-10T00:00:00.000Z'),
      to: D('2026-06-12T00:00:00.000Z'),
    });
    assert.equal(res.group, 'day');
    assert.deepStrictEqual(res.buckets.map((b) => [b.bucket, b.total]), [
      ['2026-06-10T00:00:00.000Z', 1],
      ['2026-06-11T00:00:00.000Z', 1],
    ]);
  });

  it('returns an empty bucket list when nothing matches', async () => {
    const col = createFakeCollection();
    const res = await runStats(col, { group: 'hour', from, to });
    assert.deepStrictEqual(res, {
      group: 'hour',
      from: '2026-06-11T00:00:00.000Z',
      to: '2026-06-11T03:00:00.000Z',
      buckets: [],
    });
  });

  it('passes maxTimeMS to aggregate when set, omits it otherwise', async () => {
    const calls = [];
    const stub = {
      aggregate(pipeline, opts) {
        calls.push(opts);
        return { async toArray() { return []; } };
      },
    };
    const v = { group: 'hour', from: new Date('2026-06-11T00:00:00Z'), to: new Date('2026-06-11T01:00:00Z') };
    await runStats(stub, v, { maxTimeMS: 5000 });
    await runStats(stub, v, { maxTimeMS: 0 });
    await runStats(stub, v);
    assert.deepStrictEqual(calls[0], { maxTimeMS: 5000 });
    assert.equal(calls[1], undefined);
    assert.equal(calls[2], undefined);
  });
});
