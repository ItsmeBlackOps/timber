import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MongoClient } from 'mongodb';
import { buildApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { ensureProjectIndexes } from '../src/projects.js';

const URI = process.env.TIMBER_TEST_MONGODB_URI;
const RK = 'rk-test';
const auth = { authorization: `Bearer ${RK}` };

let client, projects, server, base, shutdown;

before(async (t) => {
  if (!URI) return t.skip('TIMBER_TEST_MONGODB_URI not set');
  client = new MongoClient(URI);
  await client.connect();
  const db = client.db('timber_test_projects');
  projects = db.collection('projects');
  await projects.drop().catch(() => {});
  await ensureProjectIndexes(projects);

  const config = loadConfig({ TIMBER_KEYS: JSON.stringify([{ key: RK, app: 'a', env: 'prod', mode: 'read' }]) });
  const walWriter = { totalBytes: () => 0, overBudget: () => false, append: async () => {}, close: async () => {} };
  const flusher = { status: () => ({}), stop: async () => {}, start() {} };
  ({ server, shutdown } = buildApp(config, {
    keyring: (await import('../src/auth.js')).createKeyring(config.keys),
    walWriter, flusher,
    getCollection: () => db.collection('events'),
    getProjectsCollection: () => projects,
    now: () => new Date(),
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => { await shutdown?.(); await client?.close(); });
beforeEach(async () => { if (URI) await projects.deleteMany({}); });

test('POST creates, GET lists, slug derived', async (t) => {
  if (!URI) return t.skip('no mongo');
  const c = await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Acme Platform', apps: ['web', 'api'] }) });
  assert.equal(c.status, 201);
  const created = await c.json();
  assert.equal(created.slug, 'acme-platform');
  assert.deepEqual(created.apps, ['web', 'api']);

  const l = await (await fetch(`${base}/v1/projects`, { headers: auth })).json();
  assert.equal(l.projects.length, 1);
  assert.equal(l.projects[0].name, 'Acme Platform');
});

test('POST duplicate name -> 409', async (t) => {
  if (!URI) return t.skip('no mongo');
  await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Dup' }) });
  const r = await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'dup' }) });
  assert.equal(r.status, 409);
});

test('PATCH edits members; DELETE removes', async (t) => {
  if (!URI) return t.skip('no mongo');
  const { slug } = await (await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Edit Me', apps: ['a'] }) })).json();
  const p = await fetch(`${base}/v1/projects`, { method: 'PATCH', headers: auth, body: JSON.stringify({ slug, apps: ['a', 'b'] }) });
  assert.equal(p.status, 200);
  assert.deepEqual((await p.json()).apps, ['a', 'b']);
  const d = await fetch(`${base}/v1/projects?slug=${slug}`, { method: 'DELETE', headers: auth });
  assert.equal(d.status, 204);
  assert.equal((await (await fetch(`${base}/v1/projects`, { headers: auth })).json()).projects.length, 0);
});

test('PATCH/DELETE unknown slug -> 404; bad body -> 400; no key -> 401', async (t) => {
  if (!URI) return t.skip('no mongo');
  assert.equal((await fetch(`${base}/v1/projects`, { method: 'PATCH', headers: auth, body: JSON.stringify({ slug: 'nope', apps: [] }) })).status, 404);
  assert.equal((await fetch(`${base}/v1/projects?slug=nope`, { method: 'DELETE', headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: '{bad' })).status, 400);
  assert.equal((await fetch(`${base}/v1/projects`, { method: 'POST', body: JSON.stringify({ name: 'x' }) })).status, 401);
});
