import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCursor, decodeCursor } from '../../web/api/_lib/cursor.js';
import { createKeyring, canRead, canWrite } from '../../web/api/_lib/keyring.js';
import { validateBatch } from '../../web/api/_lib/validate.js';

test('cursor round-trips received_at + id (id kept as a string for bigint precision)', () => {
  const c = { receivedAt: new Date('2026-06-22T00:00:00Z'), id: 42 };
  const back = decodeCursor(encodeCursor(c));
  assert.equal(back.id, '42');
  assert.equal(back.receivedAt.getTime(), c.receivedAt.getTime());
  // a bigint beyond 2^53 survives exactly because id is never coerced to Number
  const big = '9007199254740993';
  assert.equal(decodeCursor(encodeCursor({ receivedAt: c.receivedAt, id: big })).id, big);
});

test('decodeCursor rejects garbage', () => {
  assert.equal(decodeCursor('!!notbase64!!'), null);
  assert.equal(decodeCursor(Buffer.from('abc:def', 'utf8').toString('base64url')), null);
});

test('keyring authenticates and scopes mode', () => {
  const ring = createKeyring([{ key: 'wkey', app: 'a', env: 'prod', mode: 'write' }]);
  const p = ring.authenticate('Bearer wkey');
  assert.deepEqual(p, { app: 'a', env: 'prod', mode: 'write' });
  assert.equal(canWrite(p), true);
  assert.equal(canRead(p), true);
  assert.equal(ring.authenticate('Bearer nope'), null);
  assert.equal(ring.authenticate(undefined), null);
});

test('read key cannot write', () => {
  const ring = createKeyring([{ key: 'rkey', app: 'a', env: 'prod', mode: 'read' }]);
  const p = ring.authenticate('Bearer rkey');
  assert.equal(canRead(p), true);
  assert.equal(canWrite(p), false);
});

test('validateBatch defaults level and reports per-index errors', () => {
  const ok = validateBatch([{ event: 'a' }, { event: 'b', level: 'warn' }], {});
  assert.equal(ok.ok, true);
  assert.equal(ok.events[0].level, 'info');
  assert.equal(ok.events[1].level, 'warn');

  const bad = validateBatch([{ event: 'a' }, { message: 'no event' }], {});
  assert.deepEqual({ ok: bad.ok, status: bad.status, index: bad.index }, { ok: false, status: 400, index: 1 });

  const tooBig = validateBatch(Array.from({ length: 3 }, () => ({ event: 'x' })), { maxBatch: 2 });
  assert.equal(tooBig.status, 413);
});
