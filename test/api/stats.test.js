import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatsQuery, buildStatsSql, mapStatsRows } from '../../web/api/_lib/sql/stats.js';

test('parseStatsQuery defaults group=hour and rejects unknown params + inverted window', () => {
  const ok = parseStatsQuery(new URLSearchParams('app=svc'));
  assert.equal(ok.ok, true);
  assert.equal(ok.value.group, 'hour');
  assert.equal(parseStatsQuery(new URLSearchParams('group=week')).ok, false);
  assert.equal(parseStatsQuery(new URLSearchParams('nope=1')).ok, false);
  assert.equal(parseStatsQuery(new URLSearchParams('from=2026-06-02&to=2026-06-01')).ok, false);
});

test('buildStatsSql buckets via date_trunc($1) and orders params group/from/to[/app]', () => {
  const value = {
    group: 'hour',
    from: new Date('2026-06-22T00:00:00Z'),
    to: new Date('2026-06-22T12:00:00Z'),
    app: 'svc',
  };
  const { text, params } = buildStatsSql(value, undefined);
  assert.match(text, /date_trunc\(\$1, received_at\)/);
  assert.match(text, /percentile_cont\(0\.95\) WITHIN GROUP \(ORDER BY lat\)/);
  assert.match(text, /FILTER \(WHERE status_num >= 400\)/);
  assert.deepEqual(params, ['hour', '2026-06-22T00:00:00.000Z', '2026-06-22T12:00:00.000Z', 'svc']);
});

test('mapStatsRows shapes a StatsBucket (null latency, errorRate, rounded cost)', () => {
  const value = { group: 'hour', from: new Date('2026-06-22T00:00:00Z'), to: new Date('2026-06-22T12:00:00Z') };
  const out = mapStatsRows(
    [
      {
        bucket: '2026-06-22T00:00:00.000Z',
        total: 3,
        debug: 0,
        info: 2,
        warn: 0,
        error: 1,
        p50: null,
        p95: null,
        p99: null,
        status_total: 2,
        status_errors: 1,
        cost_usd: 0.0050001,
        input_tokens: 10,
        output_tokens: 20,
      },
    ],
    value,
  );
  assert.equal(out.group, 'hour');
  assert.equal(out.buckets[0].total, 3);
  assert.deepEqual(out.buckets[0].counts, { debug: 0, info: 2, warn: 0, error: 1 });
  assert.equal(out.buckets[0].latency, null);
  assert.equal(out.buckets[0].errorRate, 0.5);
  assert.equal(out.buckets[0].costUsd, 0.005);
  assert.equal(out.buckets[0].inputTokens, 10);
});
