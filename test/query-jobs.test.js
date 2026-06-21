import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseJobsQuery, runJobs } from '../src/query/jobs.js';

test('parse: defaults to a 24h window; rejects unknown params', () => {
  const ok = parseJobsQuery(new URLSearchParams(''));
  assert.equal(ok.ok, true);
  assert.ok(ok.value.to.getTime() - ok.value.from.getTime() === 24 * 3600 * 1000);
  assert.equal(parseJobsQuery(new URLSearchParams('by=app')).ok, false);
});

test('runJobs: rolls up per job with status/duration/success rate', async () => {
  const fake = {
    aggregate: () => ({
      toArray: async () => [
        { _id: 'cron.report', runs: 4, failures: 1, lastRunAt: '2026-06-20T03:00:00.000Z', lastLevel: 'info', lastStatusRaw: 'ok', latencyP: [100, 400] },
        { _id: 'cron.sync', runs: 2, failures: 2, lastRunAt: '2026-06-20T02:00:00.000Z', lastLevel: 'error', lastStatusRaw: null, latencyP: [null, null] },
      ],
    }),
  };
  const out = await runJobs(fake, { from: new Date('2026-06-19'), to: new Date('2026-06-20') }, ['cron.']);
  assert.equal(out.jobs[0].name, 'cron.report');
  assert.equal(out.jobs[0].lastStatus, 'ok');
  assert.equal(out.jobs[0].successRate, 0.75);
  assert.equal(out.jobs[0].p95Ms, 400);
  assert.equal(out.jobs[1].lastStatus, 'failed');
  assert.equal(out.jobs[1].p50Ms, null);
});
