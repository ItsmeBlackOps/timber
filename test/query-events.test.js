import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runEvents } from '../src/query/events.js';
import { createFakeCollection } from './helpers/fake-collection.js';

function seededCollection() {
  const col = createFakeCollection();
  const seed = col.insertMany([
    // web events deliberately inserted out of order to prove the asc sort
    { app: 'web', env: 'prod', event: 'cron.run', level: 'info', receivedAt: new Date('2026-06-11T10:00:00Z') },
    { app: 'web', env: 'prod', event: 'ai.request', level: 'info', receivedAt: new Date('2026-06-11T10:01:00Z') },
    { app: 'web', env: 'prod', event: 'ai.request', level: 'error', receivedAt: new Date('2026-06-11T10:02:00Z') },
    { app: 'scraper', env: 'prod', event: 'db.query', level: 'warn', receivedAt: new Date('2026-06-11T10:03:00Z') },
    { app: 'scraper', env: 'prod', event: 'cron.run', level: 'info', receivedAt: new Date('2026-06-11T10:04:00Z') },
  ]);
  return seed.then(() => col);
}

test('groups distinct event names per app, events sorted ascending', async () => {
  const col = await seededCollection();
  const out = await runEvents(col, {});
  assert.deepEqual(out, {
    apps: {
      scraper: ['cron.run', 'db.query'],
      web: ['ai.request', 'cron.run'],
    },
  });
  assert.deepEqual(Object.keys(out.apps), ['scraper', 'web']);
});

test('repeated event names are deduplicated', async () => {
  const col = await seededCollection();
  const out = await runEvents(col, {});
  assert.equal(out.apps.web.filter((e) => e === 'ai.request').length, 1);
});

test('app option filters the result to that app only', async () => {
  const col = await seededCollection();
  const out = await runEvents(col, { app: 'web' });
  assert.deepEqual(out, { apps: { web: ['ai.request', 'cron.run'] } });
});

test('app filter matching nothing returns empty apps map', async () => {
  const col = await seededCollection();
  const out = await runEvents(col, { app: 'no-such-app' });
  assert.deepEqual(out, { apps: {} });
});

test('empty collection returns {apps:{}}', async () => {
  const col = createFakeCollection();
  const out = await runEvents(col, {});
  assert.deepEqual(out, { apps: {} });
});

test('issues the exact C10 pipeline, with and without app match', async () => {
  const calls = [];
  const stub = {
    aggregate(pipeline) {
      calls.push(pipeline);
      return { async toArray() { return []; } };
    },
  };
  await runEvents(stub, { app: 'web' });
  await runEvents(stub, {});
  assert.deepEqual(calls[0], [
    { $match: { app: 'web' } },
    { $group: { _id: { app: '$app', event: '$event' } } },
    { $group: { _id: '$_id.app', events: { $addToSet: '$_id.event' } } },
    { $sort: { _id: 1 } },
  ]);
  assert.deepEqual(calls[1], [
    { $group: { _id: { app: '$app', event: '$event' } } },
    { $group: { _id: '$_id.app', events: { $addToSet: '$_id.event' } } },
    { $sort: { _id: 1 } },
  ]);
});
