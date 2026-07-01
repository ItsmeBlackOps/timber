import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInsert } from '../../web/api/_lib/ingest.js';

const TTL = { debug: 7, info: 30, warn: 90, error: 90 };
const DAY_MS = 86_400_000;

test('buildInsert enriches rows with principal, received_at, and per-level expires_at', () => {
  const now = new Date('2026-06-22T00:00:00.000Z');
  const events = [
    { event: 'a', level: 'error' },
    { event: 'b', level: 'info', message: 'hi', ids: { userId: 'u1' }, data: { latencyMs: 5 } },
  ];
  const { text, params } = buildInsert(events, { app: 'svc', env: 'prod' }, TTL, now);

  assert.match(text, /^INSERT INTO events \(app, env, event, level, ts, message, ids, data, received_at, expires_at\) VALUES /);
  assert.match(text, /\$7::jsonb,\$8::jsonb/);

  // Row 0 (error => +90d), no ts/message/ids/data.
  assert.deepEqual(params.slice(0, 10), [
    'svc',
    'prod',
    'a',
    'error',
    null,
    null,
    null,
    null,
    now.toISOString(),
    new Date(now.getTime() + 90 * DAY_MS).toISOString(),
  ]);

  // Row 1 (info => +30d), ids/data serialized to JSON text for the ::jsonb cast.
  assert.equal(params[16], JSON.stringify({ userId: 'u1' }));
  assert.equal(params[17], JSON.stringify({ latencyMs: 5 }));
  assert.equal(params[18], now.toISOString());
  assert.equal(params[19], new Date(now.getTime() + 30 * DAY_MS).toISOString());
});

test('buildInsert normalizes a client ts to ISO', () => {
  const now = new Date('2026-06-22T00:00:00.000Z');
  const { params } = buildInsert([{ event: 'x', level: 'info', ts: '2026-06-21T12:00:00Z' }], { app: 'a' }, TTL, now);
  assert.equal(params[4], '2026-06-21T12:00:00.000Z');
  assert.equal(params[1], ''); // env defaults to '' when principal has none
});
