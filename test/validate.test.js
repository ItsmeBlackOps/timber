import test from 'node:test';
import assert from 'node:assert/strict';

import { LEVELS, validateEnvelope, validateBatch, enrich } from '../src/validate.js';
import { deriveId } from '../src/ids.js';

// C1 constants relevant to validation
const limits = {
  maxBatch: 500,
  maxDataBytes: 16_384,
  maxMessageChars: 512,
  maxIdsKeys: 10,
};

const ttlDays = { debug: 7, info: 30, warn: 90, error: 90 };
const DAY_MS = 86_400_000;

function assertInvalid(raw, pattern) {
  const res = validateEnvelope(raw, limits);
  assert.equal(res.ok, false);
  assert.equal(typeof res.error, 'string');
  assert.ok(res.error.length > 0, 'error message must be non-empty');
  if (pattern) assert.match(res.error, pattern);
  return res;
}

test('LEVELS is the frozen contract list', () => {
  assert.deepEqual(LEVELS, ['debug', 'info', 'warn', 'error']);
});

// --- validateEnvelope: happy paths ---

test('minimal {event} validates with level defaulting to info and no optional keys', () => {
  const res = validateEnvelope({ event: 'cron.run' }, limits);
  assert.deepEqual(res, { ok: true, value: { event: 'cron.run', level: 'info' } });
});

test('full envelope is normalized field by field', () => {
  const raw = {
    event: 'ai.request',
    level: 'warn',
    ts: '2026-06-11T09:00:00Z',
    message: 'slow call',
    ids: { taskId: 'abc', attempt: 3, cached: false },
    data: { model: 'claude-opus-4-8', latencyMs: 41200 },
  };
  const res = validateEnvelope(raw, limits);
  assert.equal(res.ok, true);
  assert.deepEqual(res.value, {
    event: 'ai.request',
    level: 'warn',
    ts: '2026-06-11T09:00:00Z',
    message: 'slow call',
    ids: { taskId: 'abc', attempt: '3', cached: 'false' }, // values coerced via String(v)
    data: { model: 'claude-opus-4-8', latencyMs: 41200 },
  });
});

test('validateEnvelope does not mutate the input object', () => {
  const raw = { event: 'x', ids: { n: 7 } };
  const snapshot = structuredClone(raw);
  validateEnvelope(raw, limits);
  assert.deepEqual(raw, snapshot);
});

test('ids with exactly maxIdsKeys keys is accepted', () => {
  const ids = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
  const res = validateEnvelope({ event: 'x', ids }, limits);
  assert.equal(res.ok, true);
  assert.equal(Object.keys(res.value.ids).length, 10);
  assert.equal(res.value.ids.k9, '9');
});

// --- validateEnvelope: invalid cases (each must be {ok:false}) ---

test('missing event is invalid', () => {
  assertInvalid({}, /event/);
});

test('empty event is invalid', () => {
  assertInvalid({ event: '' }, /event/);
});

test('non-string event is invalid', () => {
  assertInvalid({ event: 42 }, /event/);
});

test('event longer than 200 chars is invalid', () => {
  assert.equal(validateEnvelope({ event: 'e'.repeat(200) }, limits).ok, true);
  assertInvalid({ event: 'e'.repeat(201) }, /event/);
});

test('event with control chars (charCode < 32) is invalid', () => {
  assertInvalid({ event: 'a\nb' }, /event/);
  assertInvalid({ event: 'a\tb' }, /event/);
  assertInvalid({ event: 'a' + String.fromCharCode(0) + 'b' }, /event/);
  assertInvalid({ event: 'a' + String.fromCharCode(31) + 'b' }, /event/);
  // charCode 32 (space) is NOT < 32 and stays valid
  assert.equal(validateEnvelope({ event: 'a b' }, limits).ok, true);
});

test('bad level is invalid', () => {
  assertInvalid({ event: 'x', level: 'fatal' }, /level/);
  assertInvalid({ event: 'x', level: 5 }, /level/);
});

test('unparseable or non-string ts is invalid', () => {
  assertInvalid({ event: 'x', ts: 'nope' }, /ts/);
  assertInvalid({ event: 'x', ts: 1749600000000 }, /ts/);
});

test('non-string message is invalid', () => {
  assertInvalid({ event: 'x', message: 42 }, /message/);
  assertInvalid({ event: 'x', message: { text: 'hi' } }, /message/);
});

test('ids with more than maxIdsKeys keys is invalid', () => {
  const ids = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, 'v']));
  assertInvalid({ event: 'x', ids }, /ids/);
});

test('ids with non-scalar value is invalid', () => {
  assertInvalid({ event: 'x', ids: { a: {} } }, /ids/);
  assertInvalid({ event: 'x', ids: { a: ['x'] } }, /ids/);
  assertInvalid({ event: 'x', ids: { a: null } }, /ids/);
});

test('ids that is not a plain object is invalid', () => {
  assertInvalid({ event: 'x', ids: ['a'] }, /ids/);
  assertInvalid({ event: 'x', ids: null }, /ids/);
  assertInvalid({ event: 'x', ids: 'a=b' }, /ids/);
});

test('data array, scalar, or null is invalid', () => {
  assertInvalid({ event: 'x', data: [1, 2] }, /data/);
  assertInvalid({ event: 'x', data: 'str' }, /data/);
  assertInvalid({ event: 'x', data: 7 }, /data/);
  assertInvalid({ event: 'x', data: null }, /data/);
});

test('unknown top-level key is invalid', () => {
  assertInvalid({ event: 'x', foo: 1 }, /foo/);
  assertInvalid({ event: 'x', timestamp: '2026-01-01' }, /timestamp/);
});

test('non-object envelope (null, string, array) is invalid', () => {
  assert.equal(validateEnvelope(null, limits).ok, false);
  assert.equal(validateEnvelope('event', limits).ok, false);
  assert.equal(validateEnvelope([{ event: 'x' }], limits).ok, false);
});

// --- normalization details ---

test('message is silently truncated to maxMessageChars', () => {
  const long = 'm'.repeat(600);
  const res = validateEnvelope({ event: 'x', message: long }, limits);
  assert.equal(res.ok, true);
  assert.equal(res.value.message.length, 512);
  assert.equal(res.value.message, long.slice(0, 512));

  const exact = 'm'.repeat(512);
  assert.equal(validateEnvelope({ event: 'x', message: exact }, limits).value.message, exact);
});

test('data over maxDataBytes serialized is replaced by the _truncated shape', () => {
  const data = { pad: 'x'.repeat(17_000), keep: true };
  const serialized = JSON.stringify(data);
  assert.ok(serialized.length > limits.maxDataBytes, 'fixture must exceed the limit');

  const res = validateEnvelope({ event: 'x', data }, limits);
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.data, {
    _truncated: true,
    _originalBytes: serialized.length,
    _head: serialized.slice(0, 4096),
  });
  assert.equal(res.value.data._head.length, 4096);
});

test('data at or under maxDataBytes passes through untouched', () => {
  const data = { pad: 'x'.repeat(1000), n: 1 };
  const res = validateEnvelope({ event: 'x', data }, limits);
  assert.equal(res.ok, true);
  assert.deepEqual(res.value.data, data);
});

// --- validateBatch ---

test('single object body wraps into a batch of one', () => {
  const res = validateBatch({ event: 'x' }, limits);
  assert.equal(res.ok, true);
  assert.equal(res.events.length, 1);
  assert.deepEqual(res.events[0], { event: 'x', level: 'info' });
});

test('array body validates every element in order', () => {
  const res = validateBatch([{ event: 'a' }, { event: 'b', level: 'error' }], limits);
  assert.equal(res.ok, true);
  assert.deepEqual(res.events.map((e) => e.event), ['a', 'b']);
  assert.deepEqual(res.events.map((e) => e.level), ['info', 'error']);
});

test('empty array is 400 empty batch', () => {
  const res = validateBatch([], limits);
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.error, 'empty batch');
});

test('batch over maxBatch events is 413', () => {
  const batch = Array.from({ length: 501 }, () => ({ event: 'x' }));
  const res = validateBatch(batch, limits);
  assert.equal(res.ok, false);
  assert.equal(res.status, 413);
  assert.equal(typeof res.error, 'string');
});

test('batch of exactly maxBatch events is accepted', () => {
  const batch = Array.from({ length: 500 }, () => ({ event: 'x' }));
  const res = validateBatch(batch, limits);
  assert.equal(res.ok, true);
  assert.equal(res.events.length, 500);
});

test('first invalid event is reported with its index and a 400', () => {
  const batch = [{ event: 'ok1' }, { event: 'ok2' }, { event: '' }, { nope: true }];
  const res = validateBatch(batch, limits);
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.index, 2);
  assert.match(res.error, /event/);
});

test('non-object scalar body is rejected as a bad batch of one', () => {
  const res = validateBatch('not json object', limits);
  assert.equal(res.ok, false);
  assert.equal(res.status, 400);
  assert.equal(res.index, 0);
});

// --- enrich ---

const enrichCtx = {
  app: 'dailyDashboard',
  env: 'prod',
  receivedAtIso: '2026-06-11T12:00:00.000Z',
  seq: 7,
  ttlDays,
};

test('enrich produces the full doc shape with derived _id', () => {
  const { value } = validateEnvelope(
    {
      event: 'ai.request',
      level: 'warn',
      ts: '2026-06-11T11:59:58Z',
      message: 'slow',
      ids: { taskId: 't1' },
      data: { latencyMs: 9000 },
    },
    limits,
  );
  const doc = enrich(value, enrichCtx);
  assert.deepEqual(doc, {
    _id: deriveId({
      app: enrichCtx.app,
      receivedAtIso: enrichCtx.receivedAtIso,
      seq: enrichCtx.seq,
      envelope: value,
    }),
    app: 'dailyDashboard',
    env: 'prod',
    event: 'ai.request',
    level: 'warn',
    ts: '2026-06-11T11:59:58Z',
    message: 'slow',
    ids: { taskId: 't1' },
    data: { latencyMs: 9000 },
    receivedAt: '2026-06-11T12:00:00.000Z',
    expiresAt: new Date(Date.parse(enrichCtx.receivedAtIso) + 90 * DAY_MS).toISOString(),
  });
  assert.match(doc._id, /^[0-9a-f]{32}$/);
});

test('enrich omits optional keys that were not sent', () => {
  const { value } = validateEnvelope({ event: 'x' }, limits);
  const doc = enrich(value, enrichCtx);
  assert.deepEqual(Object.keys(doc).sort(), ['_id', 'app', 'env', 'event', 'expiresAt', 'level', 'receivedAt'].sort());
  assert.ok(!('ts' in doc));
  assert.ok(!('message' in doc));
  assert.ok(!('ids' in doc));
  assert.ok(!('data' in doc));
});

test('expiresAt = receivedAt + ttlDays[level] for every level', () => {
  for (const level of LEVELS) {
    const { value } = validateEnvelope({ event: 'x', level }, limits);
    const doc = enrich(value, enrichCtx);
    const expected = new Date(Date.parse(enrichCtx.receivedAtIso) + ttlDays[level] * DAY_MS).toISOString();
    assert.equal(doc.expiresAt, expected, `level=${level}`);
    assert.equal(doc.receivedAt, enrichCtx.receivedAtIso);
  }
});

test('enrich gives different _ids to identical envelopes at different seq', () => {
  const { value } = validateEnvelope({ event: 'x' }, limits);
  const a = enrich(value, enrichCtx);
  const b = enrich(value, { ...enrichCtx, seq: enrichCtx.seq + 1 });
  assert.notEqual(a._id, b._id);
});
