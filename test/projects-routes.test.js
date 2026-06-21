// Non-gated coverage for the /v1/projects + /v1/jobs HTTP branches that need no
// Mongo: auth (401), no-projects-storage (503), and request validation (400).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { createKeyring } from '../src/auth.js';

const RK = 'rk-test';
const auth = { authorization: `Bearer ${RK}` };
const walWriter = { totalBytes: () => 0, overBudget: () => false, append: async () => {}, close: async () => {} };
const flusher = { status: () => ({}), stop: async () => {}, start() {} };
const config = loadConfig({ TIMBER_KEYS: JSON.stringify([{ key: RK, app: 'a', env: 'prod', mode: 'read' }]) });

// Mount buildApp on an ephemeral port with injected fakes; `getProjectsCollection`
// is the variable under test. `getCollection` returns a truthy stub so the read
// gate passes (these tests never reach a real Mongo call).
async function withServer(getProjectsCollection, fn) {
  const { server, shutdown } = buildApp(config, {
    keyring: createKeyring(config.keys),
    walWriter, flusher,
    getCollection: () => ({}),
    getProjectsCollection,
    now: () => new Date(),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await shutdown(); }
}

test('projects routes: 503 when no projects storage', async () => {
  await withServer(() => null, async (base) => {
    const cases = [
      ['GET', '/v1/projects', undefined],
      ['POST', '/v1/projects', '{}'],
      ['PATCH', '/v1/projects', '{}'],
      ['DELETE', '/v1/projects?slug=x', undefined],
    ];
    for (const [method, path, body] of cases) {
      const r = await fetch(`${base}${path}`, { method, headers: auth, body });
      assert.equal(r.status, 503, `${method} ${path} should be 503 without projects storage`);
    }
  });
});

test('projects routes: 401 without a key', async () => {
  await withServer(() => ({}), async (base) => {
    assert.equal((await fetch(`${base}/v1/projects`)).status, 401);
    assert.equal((await fetch(`${base}/v1/projects`, { method: 'POST', body: '{}' })).status, 401);
  });
});

test('projects routes: 400 on malformed JSON, invalid body, and missing slug', async () => {
  await withServer(() => ({}), async (base) => {
    assert.equal((await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: '{bad' })).status, 400);
    assert.equal((await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ apps: [] }) })).status, 400);
    assert.equal((await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'A', color: 'red' }) })).status, 400);
    assert.equal((await fetch(`${base}/v1/projects`, { method: 'PATCH', headers: auth, body: JSON.stringify({ apps: [] }) })).status, 400);
    assert.equal((await fetch(`${base}/v1/projects?`, { method: 'DELETE', headers: auth })).status, 400);
  });
});

test('jobs route: 503 via resolveScope when ?project given but no projects storage', async () => {
  await withServer(() => null, async (base) => {
    assert.equal((await fetch(`${base}/v1/jobs?project=foo`, { headers: auth })).status, 503);
  });
});
