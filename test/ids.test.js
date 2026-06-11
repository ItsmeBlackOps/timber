import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { deriveId } from '../src/ids.js';

const base = {
  app: 'dailyDashboard',
  receivedAtIso: '2026-06-11T12:00:00.000Z',
  seq: 41,
  envelope: { event: 'ai.request', level: 'info', data: { model: 'claude-opus-4-8' } },
};

test('deriveId returns 32 lowercase hex chars', () => {
  const id = deriveId(base);
  assert.match(id, /^[0-9a-f]{32}$/);
});

test('deriveId is deterministic for identical inputs', () => {
  const a = deriveId(base);
  const b = deriveId({ ...base, envelope: { ...base.envelope } });
  assert.equal(a, b);
});

test('deriveId differs when seq differs (identical body, same ms)', () => {
  const a = deriveId(base);
  const b = deriveId({ ...base, seq: base.seq + 1 });
  assert.notEqual(a, b);
});

test('deriveId differs when app, receivedAtIso, or envelope differ', () => {
  const a = deriveId(base);
  assert.notEqual(deriveId({ ...base, app: 'scraper' }), a);
  assert.notEqual(deriveId({ ...base, receivedAtIso: '2026-06-11T12:00:00.001Z' }), a);
  assert.notEqual(deriveId({ ...base, envelope: { event: 'ai.request', level: 'warn' } }), a);
});

test('deriveId matches the pinned C3 formula: sha256(app\\nreceivedAtIso\\nseq\\nJSON(envelope)) first 32 hex', () => {
  const expected = createHash('sha256')
    .update(`${base.app}\n${base.receivedAtIso}\n${base.seq}\n${JSON.stringify(base.envelope)}`)
    .digest('hex')
    .slice(0, 32);
  assert.equal(deriveId(base), expected);
});
