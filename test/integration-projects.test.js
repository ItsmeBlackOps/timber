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

test('project scope: /v1/logs filters to member apps; unknown -> 400', async (t) => {
  if (!URI) return t.skip('no mongo');
  const db = client.db('timber_test_projects');
  const events = db.collection('events');
  await events.deleteMany({});
  await events.insertMany([
    { _id: 'e1', app: 'web', event: 'x', level: 'info', receivedAt: '2026-06-20T00:00:00.000Z' },
    { _id: 'e2', app: 'api', event: 'x', level: 'info', receivedAt: '2026-06-20T00:00:01.000Z' },
    { _id: 'e3', app: 'other', event: 'x', level: 'info', receivedAt: '2026-06-20T00:00:02.000Z' },
  ]);
  const { slug } = await (await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Scoped', apps: ['web', 'api'] }) })).json();

  const r = await (await fetch(`${base}/v1/logs?project=${slug}`, { headers: auth })).json();
  assert.deepEqual(r.items.map((i) => i.app).sort(), ['api', 'web']);

  const r2 = await (await fetch(`${base}/v1/logs?project=${slug}&app=web`, { headers: auth })).json();
  assert.deepEqual(r2.items.map((i) => i.app), ['web']);

  const r3 = await (await fetch(`${base}/v1/logs?project=${slug}&app=other`, { headers: auth })).json();
  assert.equal(r3.items.length, 0);

  assert.equal((await fetch(`${base}/v1/logs?project=nope`, { headers: auth })).status, 400);
});

test('/v1/jobs rolls up cron.* per job, project-scoped', async (t) => {
  if (!URI) return t.skip('no mongo');
  const events = client.db('timber_test_projects').collection('events');
  await events.deleteMany({});
  await events.insertMany([
    { _id: 'j1', app: 'web', event: 'cron.report', level: 'info', data: { latencyMs: 100 }, receivedAt: '2026-06-20T01:00:00.000Z' },
    { _id: 'j2', app: 'web', event: 'cron.report', level: 'error', data: { latencyMs: 200 }, receivedAt: '2026-06-20T02:00:00.000Z' },
    { _id: 'j3', app: 'other', event: 'cron.report', level: 'info', receivedAt: '2026-06-20T03:00:00.000Z' },
    { _id: 'j4', app: 'web', event: 'ai.call', level: 'info', receivedAt: '2026-06-20T04:00:00.000Z' },
  ]);
  const { slug } = await (await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Jobs P', apps: ['web'] }) })).json();
  const out = await (await fetch(`${base}/v1/jobs?project=${slug}&from=2026-06-19T00:00:00Z&to=2026-06-21T00:00:00Z`, { headers: auth })).json();
  assert.equal(out.jobs.length, 1);
  assert.equal(out.jobs[0].name, 'cron.report');
  assert.equal(out.jobs[0].runs, 2);
  assert.equal(out.jobs[0].failures, 1);
  assert.equal(out.jobs[0].lastStatus, 'failed');
});

test('PATCH rename to an existing name -> 409', async (t) => {
  if (!URI) return t.skip('no mongo');
  await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Alpha' }) });
  const { slug } = await (await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Beta' }) })).json();
  const r = await fetch(`${base}/v1/projects`, { method: 'PATCH', headers: auth, body: JSON.stringify({ slug, name: 'Alpha' }) });
  assert.equal(r.status, 409);
});

test('slug dedup: distinct names with the same slug root get a numeric suffix', async (t) => {
  if (!URI) return t.skip('no mongo');
  const a = await (await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Repeat Name' }) })).json();
  const b = await (await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'repeat   name' }) })).json();
  assert.equal(a.slug, 'repeat-name');
  assert.equal(b.slug, 'repeat-name-2');
});

test('empty project (no member apps) matches nothing on reads', async (t) => {
  if (!URI) return t.skip('no mongo');
  const events = client.db('timber_test_projects').collection('events');
  await events.deleteMany({});
  await events.insertMany([{ _id: 'x1', app: 'web', event: 'e', level: 'info', receivedAt: '2026-06-20T00:00:00.000Z' }]);
  const { slug } = await (await fetch(`${base}/v1/projects`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Empty', apps: [] }) })).json();
  const r = await (await fetch(`${base}/v1/logs?project=${slug}`, { headers: auth })).json();
  assert.equal(r.items.length, 0);
});
