import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFacetsQuery, buildFacetsSql, mapFacetsRows } from '../../web/api/_lib/sql/facets.js';
import { parseEventsQuery, buildEventsSql, mapEventsRows } from '../../web/api/_lib/sql/events.js';
import { parseJobsQuery, buildJobsSql, mapJobsRows } from '../../web/api/_lib/sql/jobs.js';

// --- facets ---
test('facets: SQL UNIONs ids/data key discovery; map splits + sorts', () => {
  const v = { from: new Date('2026-06-22T00:00:00Z'), to: new Date('2026-06-22T12:00:00Z') };
  const { text, params } = buildFacetsSql(v, undefined);
  assert.match(text, /jsonb_object_keys\(ids\)/);
  assert.match(text, /jsonb_object_keys\(data\)/);
  assert.deepEqual(params, ['2026-06-22T00:00:00.000Z', '2026-06-22T12:00:00.000Z']);
  const out = mapFacetsRows(
    [{ kind: 'ids', k: 'userId' }, { kind: 'data', k: 'status' }, { kind: 'data', k: 'costUsd' }],
    v,
  );
  assert.deepEqual(out.idsKeys, ['userId']);
  assert.deepEqual(out.dataPaths, ['costUsd', 'status']);
  assert.deepEqual(out.window, { from: '2026-06-22T00:00:00.000Z', to: '2026-06-22T12:00:00.000Z' });
});

test('facets: rejects unknown params', () => {
  assert.equal(parseFacetsQuery(new URLSearchParams('nope=1')).ok, false);
});

// --- events ---
test('events: folds (app,event) rows into { apps: { app: [events] } }', () => {
  const { text } = buildEventsSql({}, undefined);
  assert.match(text, /GROUP BY app, event ORDER BY app ASC, event ASC/);
  const out = mapEventsRows([
    { app: 'a', event: 'x' },
    { app: 'a', event: 'y' },
    { app: 'b', event: 'z' },
  ]);
  assert.deepEqual(out, { apps: { a: ['x', 'y'], b: ['z'] } });
});

// --- jobs ---
test('jobs: SQL filters by prefix + builds rollups', () => {
  const parsed = parseJobsQuery(new URLSearchParams('app=svc'));
  assert.equal(parsed.ok, true);
  const { text, params } = buildJobsSql(parsed.value, ['cron.'], undefined);
  assert.match(text, /event LIKE \$3/);
  assert.match(text, /array_agg\(level ORDER BY received_at DESC\)/);
  assert.equal(params[2], 'cron.%');
  assert.equal(params[3], 'svc'); // appScope param after the prefix
});

test('jobs: mapJobsRows detects failure, rounds successRate, nulls missing percentiles', () => {
  const v = { from: new Date('2026-06-22T00:00:00Z'), to: new Date('2026-06-22T12:00:00Z') };
  const out = mapJobsRows(
    [
      { name: 'cron.sync', runs: 3, failures: 1, last_run_at: '2026-06-22T10:00:00Z', last_level: 'info', last_status_raw: '200', p50: 12, p95: 40 },
      { name: 'cron.bad', runs: 2, failures: 2, last_run_at: '2026-06-22T09:00:00Z', last_level: 'error', last_status_raw: null, p50: null, p95: null },
    ],
    v,
  );
  assert.equal(out.jobs[0].lastStatus, 'ok');
  assert.equal(out.jobs[0].successRate, 0.6667); // round((3-1)/3, 4)
  assert.equal(out.jobs[1].lastStatus, 'failed');
  assert.equal(out.jobs[1].successRate, 0);
  assert.equal(out.jobs[1].p50Ms, null);
  assert.deepEqual(out.window, { from: '2026-06-22T00:00:00.000Z', to: '2026-06-22T12:00:00.000Z' });
});
