import { test, describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildLogflarePayload, forwardToLogflare } from '../../web/api/_lib/logflare.js';

const principal = { app: 'testapp', env: 'prod' };
const now = new Date('2026-06-30T10:00:00.000Z');

test('buildLogflarePayload maps a single event to Logflare batch format', () => {
  const events = [
    { event: 'http.request', level: 'info', ts: '2026-06-30T09:59:00.000Z',
      data: { path: '/api/health', status: 200, latencyMs: 42 } }
  ];
  const payload = buildLogflarePayload(events, principal, now);
  assert.equal(payload.batch.length, 1);
  const item = payload.batch[0];
  assert.equal(item.message, 'http.request');
  assert.equal(item.metadata.app, 'testapp');
  assert.equal(item.metadata.env, 'prod');
  assert.equal(item.metadata.level, 'info');
  assert.equal(item.metadata.data.path, '/api/health');
  assert.equal(item.metadata.receivedAt, '2026-06-30T10:00:00.000Z');
});

test('buildLogflarePayload maps multiple events to a batch array', () => {
  const events = [
    { event: 'db.query', level: 'error', data: { error: 'dup key' } },
    { event: 'db.query', level: 'info', data: { durationMs: 120 } }
  ];
  const payload = buildLogflarePayload(events, principal, now);
  assert.equal(payload.batch.length, 2);
  assert.equal(payload.batch[0].metadata.level, 'error');
  assert.equal(payload.batch[1].metadata.level, 'info');
});

test('buildLogflarePayload omits null/undefined optional fields from metadata', () => {
  const events = [{ event: 'fn.timing', level: 'info' }];
  const payload = buildLogflarePayload(events, principal, now);
  const meta = payload.batch[0].metadata;
  assert.equal('message' in meta, false);
  assert.equal('ids' in meta, false);
  assert.equal('data' in meta, false);
});

describe('forwardToLogflare', () => {
  const origFetch = globalThis.fetch;
  const fwdPrincipal = { app: 'a', env: 'prod' };
  beforeEach(() => {
    process.env.LOGFLARE_SOURCE_ID = 'src';
    process.env.LOGFLARE_API_KEY = 'key';
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    delete process.env.LOGFLARE_SOURCE_ID;
    delete process.env.LOGFLARE_API_KEY;
  });
  it('returns true when upstream is ok', async () => {
    globalThis.fetch = async () => ({ ok: true });
    assert.equal(await forwardToLogflare([{ event: 'e', level: 'info' }], fwdPrincipal), true);
  });
  it('returns false when upstream is not ok', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    assert.equal(await forwardToLogflare([{ event: 'e', level: 'info' }], fwdPrincipal), false);
  });
  it('returns false when fetch throws', async () => {
    globalThis.fetch = async () => { throw new Error('boom'); };
    assert.equal(await forwardToLogflare([{ event: 'e', level: 'info' }], fwdPrincipal), false);
  });
  it('returns false when unconfigured', async () => {
    delete process.env.LOGFLARE_SOURCE_ID;
    assert.equal(await forwardToLogflare([{ event: 'e', level: 'info' }], fwdPrincipal), false);
  });
});
