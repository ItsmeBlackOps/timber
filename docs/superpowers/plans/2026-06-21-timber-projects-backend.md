# Timber Projects, Backend Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the server side of "Projects", a registry that groups services (the per-key `app`), project-scoped reads on every query endpoint, and a `/v1/jobs` rollup, leaving the events schema untouched.

**Architecture:** A new `projects` Mongo collection (slug-keyed) with CRUD under `/v1/projects`. A `project=<slug>` param on the read endpoints is resolved (server-side) to the project's `apps` and applied as an `app $in {...}` clause via one shared `appScope()` helper. A new `/v1/jobs` aggregation rolls up `cron.*` events per job. Everything reuses the existing `buildApp(config, deps)` DI, `readGate`, `parse*/run*` shape, and `node:test` harness.

**Tech Stack:** Node 22 ESM, pure `node:http`, `mongodb` v6, `node:test` + `node:assert/strict`. Spec: [docs/superpowers/specs/2026-06-21-timber-projects-design.md](../specs/2026-06-21-timber-projects-design.md).

**Scope note:** This plan is the **backend only**. The Console (ProjectSwitcher, Manage Projects, Overview, Jobs dashboard) is **Plan 2**, written after this lands so it targets the real, tested API.

**Conventions (match existing code):**
- Run all tests: `node --test "test/**/*.test.js"`. One file: `node --test test/projects.test.js`.
- Mongo-backed tests gate on `TIMBER_TEST_MONGODB_URI` (see `test/integration-mongo.test.js`); pure-unit tests need no Mongo.
- Commit messages: plain subject + optional body. **No AI-attribution trailers.**
- After each task: run the named test(s), confirm green, then commit.

---

## File Structure

**Create:**
- `src/query/scope.js`, `appScope(app, apps)` → the Mongo `app` match clause. One responsibility: project/app scope.
- `src/projects.js`, project registry: pure validation + slug helpers + thin Mongo data access (list/create/update/delete/resolve). No HTTP.
- `src/query/jobs.js`, `parseJobsQuery` / `buildJobsPipeline` / `runJobs`. Mirrors `src/query/stats.js`.
- `test/scope.test.js`, `test/projects.test.js`, `test/query-jobs.test.js`, `test/integration-projects.test.js` (Mongo-gated).

**Modify:**
- `src/config.js`, add `mongoProjectsCollectionName` + `jobsEventPrefixes`.
- `src/mongo.js`, no change required (projects collection is obtained from the same client in `server.js`). Indexes live in `src/projects.js`.
- `src/server.js`, new `getProjectsCollection` dep; `/v1/projects` CRUD routes; `resolveScope()` + thread `apps` into the 5 read handlers; `/v1/jobs` route; connect the projects collection in `main()`.
- `src/query/logs.js`, `src/query/groupby.js`, `src/query/stats.js`, `src/query/events.js`, `src/query/facets.js`, apply `appScope` in each `run*`/`build*Pipeline`.
- `test/config.test.js`, assert the two new config fields.
- `USAGE.md`, `.env.example`, `README.md`, document the endpoints + config.

---

## Task 1: Config, projects collection + jobs prefixes

**Files:**
- Modify: `src/config.js`
- Test: `test/config.test.js`

- [ ] **Step 1: Write failing tests**, append to `test/config.test.js`:

```js
test('projects + jobs config: defaults', (t) => {
  quietStderr(t);
  const cfg = loadConfig({});
  assert.equal(cfg.mongoProjectsCollectionName, 'projects');
  assert.deepEqual(cfg.jobsEventPrefixes, ['cron.']);
});

test('projects + jobs config: overrides (CSV prefixes trimmed)', (t) => {
  quietStderr(t);
  const cfg = loadConfig({
    TIMBER_PROJECTS_COLLECTION: 'proj',
    TIMBER_JOBS_EVENT_PREFIX: 'cron., job. , task.',
  });
  assert.equal(cfg.mongoProjectsCollectionName, 'proj');
  assert.deepEqual(cfg.jobsEventPrefixes, ['cron.', 'job.', 'task.']);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --test test/config.test.js`
Expected: FAIL (`cfg.mongoProjectsCollectionName` is `undefined`).

- [ ] **Step 3: Implement**, in `src/config.js`, add a CSV helper after `clampedKbToBytes` (near line 61):

```js
function csvEnv(env, name, def) {
  const s = rawEnv(env, name) ?? def;
  return Object.freeze(
    s.split(',').map((x) => x.trim()).filter((x) => x.length > 0),
  );
}
```

Then inside the `loadConfig` returned object, add after `mongoCollectionName:` (line 110):

```js
    mongoProjectsCollectionName: strEnv(env, 'TIMBER_PROJECTS_COLLECTION', 'projects'),
```

and after `queryMaxTimeMs:` (line 131):

```js
    jobsEventPrefixes: csvEnv(env, 'TIMBER_JOBS_EVENT_PREFIX', 'cron.'),
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test test/config.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.js test/config.test.js
git commit -m "feat(projects): config for projects collection + jobs event prefixes"
```

---

## Task 2: `appScope` helper

**Files:**
- Create: `src/query/scope.js`
- Test: `test/scope.test.js`

- [ ] **Step 1: Write failing test**, `test/scope.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appScope } from '../src/query/scope.js';

test('no app, no project -> no constraint', () => {
  assert.deepEqual(appScope(undefined, undefined), {});
  assert.deepEqual(appScope('', undefined), {});
});
test('single app, no project -> equality', () => {
  assert.deepEqual(appScope('web', undefined), { app: 'web' });
});
test('project only -> $in over member apps', () => {
  assert.deepEqual(appScope(undefined, ['web', 'api']), { app: { $in: ['web', 'api'] } });
});
test('empty project -> matches nothing', () => {
  assert.deepEqual(appScope(undefined, []), { app: { $in: [] } });
});
test('app within project -> drill-down equality', () => {
  assert.deepEqual(appScope('web', ['web', 'api']), { app: 'web' });
});
test('app outside project -> matches nothing', () => {
  assert.deepEqual(appScope('x', ['web', 'api']), { app: { $in: [] } });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --test test/scope.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**, `src/query/scope.js`:

```js
// Build the Mongo `app` match clause from an optional single app and an optional
// resolved project app-set. Spread the result into a $match / find filter.
//
//   appScope(undefined, undefined) -> {}                      no constraint
//   appScope('web',     undefined) -> { app: 'web' }          single service
//   appScope(undefined, ['a','b']) -> { app: { $in: ['a','b'] } }   project scope
//   appScope(undefined, [])        -> { app: { $in: [] } }    empty project: nothing
//   appScope('web', ['web','api']) -> { app: 'web' }          member drill-down
//   appScope('x',   ['web','api']) -> { app: { $in: [] } }    non-member: nothing
export function appScope(app, apps) {
  const hasApp = typeof app === 'string' && app.length > 0;
  if (Array.isArray(apps)) {
    if (hasApp) return apps.includes(app) ? { app } : { app: { $in: [] } };
    return { app: { $in: apps } };
  }
  return hasApp ? { app } : {};
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test test/scope.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/query/scope.js test/scope.test.js
git commit -m "feat(projects): appScope() query helper for project/app scoping"
```

---

## Task 3: Projects registry module (validation + slug + data access)

**Files:**
- Create: `src/projects.js`
- Test: `test/projects.test.js` (pure-unit: validation + slug only)

- [ ] **Step 1: Write failing tests**, `test/projects.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slugify, validateProjectInput } from '../src/projects.js';

test('slugify: kebab-cases and trims', () => {
  assert.equal(slugify('Acme Platform'), 'acme-platform');
  assert.equal(slugify('  Weird__Name!!  '), 'weird-name');
});

test('validate create: requires a non-empty name', () => {
  assert.equal(validateProjectInput({}, { partial: false }).ok, false);
  assert.equal(validateProjectInput({ name: '   ' }).ok, false);
});

test('validate create: trims name, defaults apps to []', () => {
  const r = validateProjectInput({ name: '  Acme  ' });
  assert.deepEqual(r, { ok: true, value: { name: 'Acme', apps: [] } });
});

test('validate: apps must be unique non-empty strings', () => {
  assert.equal(validateProjectInput({ name: 'A', apps: ['', 'x'] }).ok, false);
  assert.equal(validateProjectInput({ name: 'A', apps: [1] }).ok, false);
  assert.deepEqual(
    validateProjectInput({ name: 'A', apps: ['web', 'web', 'api'] }).value.apps,
    ['web', 'api'],
  );
});

test('validate: rejects unknown keys', () => {
  assert.equal(validateProjectInput({ name: 'A', color: 'red' }).ok, false);
});

test('validate patch: name optional, unknown key rejected', () => {
  assert.deepEqual(validateProjectInput({ apps: ['x'] }, { partial: true }), {
    ok: true, value: { apps: ['x'] },
  });
  assert.equal(validateProjectInput({ slug: 'a' }, { partial: true }).ok, false);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --test test/projects.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**, `src/projects.js`:

```js
// Server-side project registry. A project groups services (the per-key `app`).
// `slug` is the stable, public identifier; the Mongo `_id` (ObjectId) stays
// internal and is never returned. Validation mirrors src/validate.js style.
const NAME_MAX = 80;
const APPS_MAX = 200;
const APP_MAX_CHARS = 128;

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (error) => ({ ok: false, error });

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, NAME_MAX);
}

// Validate a create (partial:false) or patch (partial:true) body. Allowed keys
// are exactly { name, apps }. Returns { ok, value } | { ok:false, error }.
export function validateProjectInput(raw, { partial = false } = {}) {
  if (!isPlainObject(raw)) return invalid('project body must be a JSON object');
  for (const key of Object.keys(raw)) {
    if (key !== 'name' && key !== 'apps') return invalid(`unknown key "${key}"`);
  }
  const value = {};
  if (raw.name !== undefined) {
    if (typeof raw.name !== 'string') return invalid('name must be a string');
    const name = raw.name.trim();
    if (name.length === 0) return invalid('name must be a non-empty string');
    if (name.length > NAME_MAX) return invalid(`name exceeds ${NAME_MAX} chars`);
    value.name = name;
  } else if (!partial) {
    return invalid('name is required');
  }
  if (raw.apps !== undefined) {
    if (!Array.isArray(raw.apps)) return invalid('apps must be an array of strings');
    if (raw.apps.length > APPS_MAX) return invalid(`apps exceeds ${APPS_MAX} entries`);
    const apps = [];
    for (const a of raw.apps) {
      if (typeof a !== 'string' || a.length === 0) return invalid('each app must be a non-empty string');
      if (a.length > APP_MAX_CHARS) return invalid(`app name exceeds ${APP_MAX_CHARS} chars`);
      if (!apps.includes(a)) apps.push(a);
    }
    value.apps = apps;
  } else if (!partial) {
    value.apps = [];
  }
  return { ok: true, value };
}

const toView = (doc) => ({ slug: doc.slug, name: doc.name, apps: doc.apps ?? [] });

export async function ensureProjectIndexes(collection) {
  await collection.createIndexes([
    { key: { slug: 1 }, unique: true },
    { key: { nameLower: 1 }, unique: true },
  ]);
}

export async function listProjects(collection, { maxTimeMS } = {}) {
  let cursor = collection.find({}).sort({ nameLower: 1 });
  if (Number.isFinite(maxTimeMS) && maxTimeMS > 0) cursor = cursor.maxTimeMS(maxTimeMS);
  return (await cursor.toArray()).map(toView);
}

async function uniqueSlug(collection, base) {
  const root = base || 'project';
  let slug = root;
  for (let n = 2; ; n++) {
    const clash = await collection.findOne({ slug }, { projection: { _id: 1 } });
    if (!clash) return slug;
    slug = `${root}-${n}`;
  }
}

export async function createProject(collection, input, { now }) {
  const slug = await uniqueSlug(collection, slugify(input.name));
  const nowIso = now().toISOString();
  const doc = {
    slug,
    name: input.name,
    nameLower: input.name.toLowerCase(),
    apps: input.apps ?? [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  try {
    await collection.insertOne(doc);
  } catch (err) {
    if (err && err.code === 11000) return { ok: false, conflict: true };
    throw err;
  }
  return { ok: true, value: toView(doc) };
}

export async function updateProject(collection, slug, patch, { now }) {
  const existing = await collection.findOne({ slug });
  if (!existing) return { ok: false, notFound: true };
  const set = { updatedAt: now().toISOString() };
  if (patch.name !== undefined) {
    set.name = patch.name;
    set.nameLower = patch.name.toLowerCase();
  }
  if (patch.apps !== undefined) set.apps = patch.apps;
  try {
    await collection.updateOne({ slug }, { $set: set });
  } catch (err) {
    if (err && err.code === 11000) return { ok: false, conflict: true };
    throw err;
  }
  return { ok: true, value: toView({ ...existing, ...set }) };
}

export async function deleteProject(collection, slug) {
  const res = await collection.deleteOne({ slug });
  return res.deletedCount > 0;
}

// Resolve a slug to its member apps for query scoping. Returns the apps array
// (possibly empty) or null when the slug is unknown.
export async function resolveProjectApps(collection, slug, { maxTimeMS } = {}) {
  const doc = await collection.findOne({ slug }, { projection: { apps: 1 } });
  if (!doc) return null;
  return doc.apps ?? [];
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test test/projects.test.js`
Expected: PASS (6 tests). (Data-access functions are exercised in Task 5's Mongo-gated test.)

- [ ] **Step 5: Commit**

```bash
git add src/projects.js test/projects.test.js
git commit -m "feat(projects): registry module, validation, slug, Mongo data access"
```

---

## Task 4: Wire the projects collection through DI

**Files:**
- Modify: `src/server.js` (DI + `main()` connect)

- [ ] **Step 1: Add the import**, in `src/server.js` after the `connectMongo` import (line 23):

```js
import { ensureProjectIndexes } from './projects.js';
```

- [ ] **Step 2: Accept the new dep**, change the `buildApp` destructure (line 61) from:

```js
  const { keyring, walWriter, flusher, getCollection, now } = deps;
```
to:
```js
  const { keyring, walWriter, flusher, getCollection, getProjectsCollection, now } = deps;
```

(Existing tests that don't pass `getProjectsCollection` keep working: the projects routes guard with optional chaining and answer 503, exactly like a missing events collection.)

- [ ] **Step 3: Connect projects in `main()`**, in the background connect loop (around line 348-355), after `await ensureIndexes(conn.collection);` add the projects collection from the same client, and expose it. Replace the block:

```js
          const conn = await connectMongo(config.mongodbUri, {
            dbName: config.mongoDbName,
            collectionName: config.mongoCollectionName,
          });
          await ensureIndexes(conn.collection);
          client = conn.client;
          collection = conn.collection;
          log(`mongo connected (db=${config.mongoDbName} collection=${config.mongoCollectionName})`);
```
with:
```js
          const conn = await connectMongo(config.mongodbUri, {
            dbName: config.mongoDbName,
            collectionName: config.mongoCollectionName,
          });
          await ensureIndexes(conn.collection);
          const projects = conn.client.db(config.mongoDbName).collection(config.mongoProjectsCollectionName);
          await ensureProjectIndexes(projects);
          client = conn.client;
          collection = conn.collection;
          projectsCollection = projects;
          log(`mongo connected (db=${config.mongoDbName} collection=${config.mongoCollectionName}, projects=${config.mongoProjectsCollectionName})`);
```

- [ ] **Step 4: Declare + pass the getter**, near `let collection = null;` (line 314) add:

```js
  let projectsCollection = null;
```
and add a getter after `const getCollection = () => collection;` (line 316):
```js
  const getProjectsCollection = () => projectsCollection;
```
then add it to the `buildApp(config, { ... })` deps (line 326-332):
```js
    getProjectsCollection,
```

- [ ] **Step 5: Verify nothing regressed**

Run: `node --test test/server.test.js`
Expected: PASS (no behavior change yet; the dep is additive).

- [ ] **Step 6: Commit**

```bash
git add src/server.js
git commit -m "feat(projects): wire projects collection through buildApp DI"
```

---

## Task 5: Projects CRUD routes

**Files:**
- Modify: `src/server.js`
- Test: `test/integration-projects.test.js` (Mongo-gated)

> **Router note:** `src/http/router.js` matches `METHOD pathname` exactly (no path params). So the slug travels in the body (PATCH) or `?slug=` (DELETE), all under `/v1/projects`.

- [ ] **Step 1: Write failing Mongo-gated test**, `test/integration-projects.test.js` (mirror the setup in `test/integration-mongo.test.js:90-110`):

```js
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
```

- [ ] **Step 2: Run, verify it fails**

Run: `TIMBER_TEST_MONGODB_URI="$TIMBER_TEST_MONGODB_URI" node --test test/integration-projects.test.js`
Expected: FAIL (routes 404), or `t.skip` if no Mongo URI; set one to validate.

- [ ] **Step 3: Implement the routes**, in `src/server.js`, add the imports after the `ensureProjectIndexes` import:

```js
import {
  listProjects, createProject, updateProject, deleteProject, validateProjectInput,
} from './projects.js';
```

Inside `buildApp`, after `readGate` (line 95), add the gate + body helper + routes:

```js
  // Project-registry routes. Per design, a read key suffices for list AND mutate
  // (the read key already exposes all logs, so project metadata is not the weakest
  // link). Returns the projects collection or null after sending 401/503.
  function projectsGate(req, res) {
    const principal = keyring.authenticate(req.headers.authorization);
    if (!canRead(principal)) { unauthorized(res); return null; }
    const pc = getProjectsCollection?.();
    if (!pc) { sendError(res, 503, 'storage unavailable'); return null; }
    return pc;
  }

  async function readJsonBody(req, res) {
    const body = await readBody(req, config.maxBodyBytes);
    if (!body.ok) { sendError(res, body.status, 'request body too large'); return undefined; }
    try { return JSON.parse(body.buffer.toString('utf8')); }
    catch { sendError(res, 400, 'request body is not valid JSON'); return undefined; }
  }

  router.add('GET', '/v1/projects', async (req, res) => {
    const pc = projectsGate(req, res); if (!pc) return;
    sendJson(res, 200, { projects: await listProjects(pc, { maxTimeMS: config.queryMaxTimeMs }) });
  });

  router.add('POST', '/v1/projects', async (req, res) => {
    const pc = projectsGate(req, res); if (!pc) return;
    const raw = await readJsonBody(req, res); if (raw === undefined) return;
    const v = validateProjectInput(raw, { partial: false });
    if (!v.ok) return sendError(res, 400, v.error);
    const created = await createProject(pc, v.value, { now });
    if (!created.ok) return sendError(res, 409, 'project name already exists');
    sendJson(res, 201, created.value);
  });

  router.add('PATCH', '/v1/projects', async (req, res) => {
    const pc = projectsGate(req, res); if (!pc) return;
    const raw = await readJsonBody(req, res); if (raw === undefined) return;
    if (!raw || typeof raw !== 'object' || typeof raw.slug !== 'string' || raw.slug.length === 0) {
      return sendError(res, 400, 'slug is required');
    }
    const { slug, ...rest } = raw;
    const v = validateProjectInput(rest, { partial: true });
    if (!v.ok) return sendError(res, 400, v.error);
    const updated = await updateProject(pc, slug, v.value, { now });
    if (updated.notFound) return sendError(res, 404, 'project not found');
    if (updated.conflict) return sendError(res, 409, 'project name already exists');
    sendJson(res, 200, updated.value);
  });

  router.add('DELETE', '/v1/projects', async (req, res, url) => {
    const pc = projectsGate(req, res); if (!pc) return;
    const slug = url.searchParams.get('slug');
    if (!slug) return sendError(res, 400, 'slug query parameter is required');
    const ok = await deleteProject(pc, slug);
    if (!ok) return sendError(res, 404, 'project not found');
    res.writeHead(204); res.end();
  });
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test test/integration-projects.test.js` (with `TIMBER_TEST_MONGODB_URI` set)
Expected: PASS (4 tests). Also run `node --test test/server.test.js` (no regressions).

- [ ] **Step 5: Commit**

```bash
git add src/server.js test/integration-projects.test.js
git commit -m "feat(projects): CRUD routes under /v1/projects (read-key gated)"
```

---

## Task 6: Project-scoped reads

**Files:**
- Modify: `src/query/logs.js`, `src/query/groupby.js`, `src/query/stats.js`, `src/query/events.js`, `src/query/facets.js`, `src/server.js`
- Test: extend `test/integration-projects.test.js`

- [ ] **Step 1: Write failing test**, append to `test/integration-projects.test.js`:

```js
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

  // drill-down to one member
  const r2 = await (await fetch(`${base}/v1/logs?project=${slug}&app=web`, { headers: auth })).json();
  assert.deepEqual(r2.items.map((i) => i.app), ['web']);

  // non-member app -> nothing
  const r3 = await (await fetch(`${base}/v1/logs?project=${slug}&app=other`, { headers: auth })).json();
  assert.equal(r3.items.length, 0);

  // unknown project -> 400
  assert.equal((await fetch(`${base}/v1/logs?project=nope`, { headers: auth })).status, 400);
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --test test/integration-projects.test.js`
Expected: FAIL (`project` is an unknown param → 400 for the valid-slug case too, and member filtering absent).

- [ ] **Step 3a: Thread `apps` into the query modules.**

`src/query/logs.js`, add the import at top and apply scope in `runLogsQuery`:
```js
import { appScope } from './scope.js';
```
Change `runLogsQuery` signature + first statement (line 313):
```js
export async function runLogsQuery(collection, { filter, limit, apps }, { maxTimeMS } = {}) {
  const scoped = { ...filter, ...appScope(filter.app, apps) };
  let cursor = collection
    .find(scoped)
    .sort({ receivedAt: -1, _id: -1 })
    .limit(limit + 1);
```
(Use `scoped` in `.find(...)`; the rest of the function is unchanged.)

`src/query/groupby.js`, add `import { appScope } from './scope.js';` and change `buildGroupByPipeline` (line 95) to accept/apply `apps`:
```js
export function buildGroupByPipeline({ by, filter, limit, like, apps }) {
  return [
    { $match: { ...filter, ...appScope(filter.app, apps) } },
```
(rest unchanged).

`src/query/stats.js`, add `import { appScope } from './scope.js';` and change `buildStatsPipeline` (line 65) `$match`:
```js
export function buildStatsPipeline({ group, from, to, app, event, apps }) {
  return [
    {
      $match: {
        receivedAt: { $gte: from, $lt: to },
        ...appScope(app, apps),
        ...(event && { event: { $regex: '^' + escapeRegex(event) } }),
      },
    },
```
(replaces the old `...(app && { app })`).

`src/query/facets.js`, add `import { appScope } from './scope.js';` and change `buildFacetsPipeline` (line 56):
```js
export function buildFacetsPipeline({ from, to, app, apps }) {
  return [
    { $match: { receivedAt: { $gte: from, $lt: to }, ...appScope(app, apps) } },
```
(replaces `...(app && { app })`).

`src/query/events.js`, add `import { appScope } from './scope.js';` and change `runEvents` (line 16):
```js
export async function runEvents(collection, { app, apps } = {}, { maxTimeMS } = {}) {
  const scope = appScope(app, apps);
  const pipeline = [
    ...(Object.keys(scope).length ? [{ $match: scope }] : []),
    { $group: { _id: { app: '$app', event: '$event' } } },
    { $group: { _id: '$_id.app', events: { $addToSet: '$_id.event' } } },
    { $sort: { _id: 1 } },
  ];
```
(rest unchanged).

- [ ] **Step 3b: Resolve `project` in `src/server.js`.** Add the import:
```js
import { resolveProjectApps } from './projects.js';
```
(merge into the existing `./projects.js` import line). Add a resolver inside `buildApp` after `readGate`:
```js
  // Pull an optional ?project=<slug> out of the query, resolve it to member apps,
  // and remove it so the per-endpoint parsers (which 400 on unknown params) never
  // see it. Returns { ok, apps }, apps is undefined (no scope), an array, or the
  // call already sent 400 (unknown project) / 503 (no projects storage).
  async function resolveScope(url, res) {
    const slug = url.searchParams.get('project');
    if (slug === null) return { ok: true, apps: undefined };
    url.searchParams.delete('project');
    const pc = getProjectsCollection?.();
    if (!pc) { sendError(res, 503, 'storage unavailable'); return { ok: false }; }
    const apps = await resolveProjectApps(pc, slug, { maxTimeMS: config.queryMaxTimeMs });
    if (apps === null) { sendError(res, 400, `unknown project "${slug}"`); return { ok: false }; }
    return { ok: true, apps };
  }
```
Then in EACH of the five read handlers, call it right after `readGate` and attach `apps` after parsing. Pattern (apply to `/v1/logs`, `/v1/stats`, `/v1/events`, `/v1/facets`, `/v1/groupby`):
```js
  router.add('GET', '/v1/logs', async (req, res, url) => {
    const collection = readGate(req, res);
    if (!collection) return;
    const scope = await resolveScope(url, res);
    if (!scope.ok) return;
    const parsed = parseLogsQuery(url.searchParams);
    if (!parsed.ok) return sendError(res, 400, parsed.error);
    parsed.value.apps = scope.apps;
    sendJson(res, 200, await runLogsQuery(collection, parsed.value, { maxTimeMS: config.queryMaxTimeMs }));
  });
```
Repeat the two added lines (`const scope = await resolveScope(...)` / `if (!scope.ok) return;` after `readGate`, and `parsed.value.apps = scope.apps;` after the `parsed.ok` check) in the stats, events, facets, and groupby handlers (lines 201-231).

- [ ] **Step 4: Run, verify pass**

Run: `node --test test/integration-projects.test.js` then `node --test "test/**/*.test.js"`
Expected: PASS, no regressions (existing query tests pass `apps: undefined` → `appScope` returns `{}` / single-app, identical behavior).

- [ ] **Step 5: Commit**

```bash
git add src/query/ src/server.js test/integration-projects.test.js
git commit -m "feat(projects): project= scope on logs/stats/events/facets/groupby"
```

---

## Task 7: `/v1/jobs` rollup endpoint

**Files:**
- Create: `src/query/jobs.js`
- Modify: `src/server.js`
- Test: `test/query-jobs.test.js` (unit, fake collection) + extend `test/integration-projects.test.js`

- [ ] **Step 1: Write failing unit test**, `test/query-jobs.test.js` (mirror the pure pipeline/post-process testing in `test/query-stats.test.js`):

```js
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
  // Minimal fake: returns canned aggregate rows so we test post-processing.
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
```

- [ ] **Step 2: Run, verify it fails**

Run: `node --test test/query-jobs.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**, `src/query/jobs.js`:

```js
// GET /v1/jobs, per-job rollups over job events (name starts with a configured
// prefix, default `cron.`) within a time window + project scope. Mirrors the
// parse/build/run shape of src/query/stats.js.
import { appScope } from './scope.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const OWN_PARAMS = new Set(['from', 'to', 'app']); // `project` is stripped by the handler
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseDate = (raw) => {
  const d = /^\d+$/.test(raw) ? new Date(Number(raw)) : new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function parseJobsQuery(searchParams) {
  for (const name of searchParams.keys()) {
    if (!OWN_PARAMS.has(name)) return { ok: false, error: `unknown parameter: ${name}` };
  }
  const toRaw = searchParams.get('to');
  let to = new Date();
  if (toRaw !== null) {
    to = parseDate(toRaw);
    if (to === null) return { ok: false, error: 'to: expected ISO-8601 date or epoch milliseconds' };
  }
  const fromRaw = searchParams.get('from');
  let from = new Date(to.getTime() - DAY_MS);
  if (fromRaw !== null) {
    from = parseDate(fromRaw);
    if (from === null) return { ok: false, error: 'from: expected ISO-8601 date or epoch milliseconds' };
  }
  if (from.getTime() >= to.getTime()) {
    return { ok: false, error: 'from must be earlier than to (got an inverted or empty time window)' };
  }
  const value = { from, to };
  const app = searchParams.get('app');
  if (app) value.app = app;
  return { ok: true, value };
}

const toDoubleN = (input) => ({ $convert: { input, to: 'double', onError: null, onNull: null } });
const failedExpr = {
  $cond: [
    {
      $or: [
        { $eq: ['$level', 'error'] },
        { $in: [{ $toLower: { $ifNull: ['$data.status', ''] } }, ['error', 'failed', 'failure']] },
      ],
    },
    1, 0,
  ],
};

export function buildJobsPipeline({ from, to, app, apps }, prefixes) {
  const prefixRe = '^(' + prefixes.map(escapeRegex).join('|') + ')';
  return [
    { $match: { receivedAt: { $gte: from, $lt: to }, event: { $regex: prefixRe }, ...appScope(app, apps) } },
    { $sort: { receivedAt: 1 } },
    {
      $group: {
        _id: '$event',
        runs: { $sum: 1 },
        failures: { $sum: failedExpr },
        lastRunAt: { $last: '$receivedAt' },
        lastLevel: { $last: '$level' },
        lastStatusRaw: { $last: { $ifNull: ['$data.status', null] } },
        latencyP: { $percentile: { input: toDoubleN('$data.latencyMs'), p: [0.5, 0.95], method: 'approximate' } },
      },
    },
    { $sort: { runs: -1, _id: 1 } },
    { $limit: 200 },
  ];
}

export async function runJobs(collection, value, prefixes, { maxTimeMS } = {}) {
  const opts = Number.isFinite(maxTimeMS) && maxTimeMS > 0 ? { maxTimeMS } : undefined;
  const rows = await collection.aggregate(buildJobsPipeline(value, prefixes), opts).toArray();
  const jobs = rows.map((r) => {
    const lp = r.latencyP ?? [null, null];
    const statusStr = r.lastStatusRaw == null ? '' : String(r.lastStatusRaw).toLowerCase();
    const lastFailed = r.lastLevel === 'error' || ['error', 'failed', 'failure'].includes(statusStr);
    return {
      name: r._id,
      lastRunAt: r.lastRunAt,
      lastStatus: lastFailed ? 'failed' : 'ok',
      runs: r.runs,
      failures: r.failures,
      successRate: r.runs ? (r.runs - r.failures) / r.runs : null,
      p50Ms: lp[0] == null ? null : lp[0],
      p95Ms: lp[1] == null ? null : lp[1],
    };
  });
  return { jobs, window: { from: value.from.toISOString(), to: value.to.toISOString() } };
}
```

- [ ] **Step 4: Register the route**, in `src/server.js` add the import (merge with other query imports):
```js
import { parseJobsQuery, runJobs } from './query/jobs.js';
```
and add the route after `/v1/groupby` (line 231):
```js
  router.add('GET', '/v1/jobs', async (req, res, url) => {
    const collection = readGate(req, res);
    if (!collection) return;
    const scope = await resolveScope(url, res);
    if (!scope.ok) return;
    const parsed = parseJobsQuery(url.searchParams);
    if (!parsed.ok) return sendError(res, 400, parsed.error);
    parsed.value.apps = scope.apps;
    sendJson(res, 200, await runJobs(collection, parsed.value, config.jobsEventPrefixes, { maxTimeMS: config.queryMaxTimeMs }));
  });
```

- [ ] **Step 5: Add a Mongo-gated integration test**, append to `test/integration-projects.test.js`:
```js
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
  assert.equal(out.jobs.length, 1); // only cron.report on web (other app excluded, ai.call excluded)
  assert.equal(out.jobs[0].name, 'cron.report');
  assert.equal(out.jobs[0].runs, 2);
  assert.equal(out.jobs[0].failures, 1);
  assert.equal(out.jobs[0].lastStatus, 'failed'); // latest run (j2) was level error
});
```

- [ ] **Step 6: Run, verify pass**

Run: `node --test test/query-jobs.test.js` then `node --test test/integration-projects.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/query/jobs.js src/server.js test/query-jobs.test.js test/integration-projects.test.js
git commit -m "feat(projects): /v1/jobs per-job rollup endpoint (project-scoped)"
```

---

## Task 8: Documentation

**Files:**
- Modify: `USAGE.md`, `.env.example`, `README.md`

- [ ] **Step 1: USAGE.md**, add two env rows to the table (after the `WATCHTOWER_POLL_INTERVAL` row):

```md
| `TIMBER_PROJECTS_COLLECTION` | `projects` | Mongo collection holding project metadata (name + member services) |
| `TIMBER_JOBS_EVENT_PREFIX` | `cron.` | comma-separated event-name prefixes treated as jobs by `/v1/jobs` |
```

Add a new `## Projects` section after `## Group & count` documenting: `GET/POST/PATCH/DELETE /v1/projects` (read key; PATCH carries `slug` in the body, DELETE via `?slug=`), the `project=<slug>` param on `/v1/logs|stats|events|facets|groupby`, and `GET /v1/jobs` (params `from`/`to`/`app`/`project`; returns `{ jobs:[{name,lastRunAt,lastStatus,runs,failures,successRate,p50Ms,p95Ms}], window }`).

- [ ] **Step 2: .env.example**, add under the optional section:
```ini
# TIMBER_PROJECTS_COLLECTION=projects   # Mongo collection for project metadata
# TIMBER_JOBS_EVENT_PREFIX=cron.        # event-name prefixes treated as jobs
```

- [ ] **Step 3: README.md**, in the API summary near the faceting endpoints note, add one line: projects + project-scoped reads + `/v1/jobs` back the Console's Projects feature.

- [ ] **Step 4: Verify docs match the API**, re-read the new section against the routes in `src/server.js`; confirm method/path/params line up.

- [ ] **Step 5: Commit**

```bash
git add USAGE.md .env.example README.md
git commit -m "docs(projects): document /v1/projects, project= scope, /v1/jobs + config"
```

---

## Self-Review

**Spec coverage:** Projects collection (T3) ✓ · CRUD API (T5) ✓ · `project` param resolving to `app $in` on all 5 read endpoints (T6) ✓ · single-`app` drill-down within project (T6, `appScope`) ✓ · `/v1/jobs` with status/duration/percentile + fallbacks (T7) ✓ · `canRead` gate on list + mutate (T5) ✓ · config `TIMBER_PROJECTS_COLLECTION` + `TIMBER_JOBS_EVENT_PREFIX` (T1) ✓ · validation mirroring `validate.js` (T3) ✓ · error handling 400/401/404/409/503 (T5) ✓ · docs (T8) ✓. Console items are intentionally **out of scope** (Plan 2).

**Deviations from spec (intentional, noted):** (1) slug is the public identifier (no `_id`/ObjectId exposed), simpler, avoids ObjectId edge cases; `project=<slug>`. (2) Duplicate-name returns **409** (Conflict), not 400, more correct REST; documented. (3) PATCH carries `slug` in the body and DELETE via `?slug=` because `src/http/router.js` is exact-match (no path params), avoids a risky router rewrite.

**Placeholder scan:** none, every step has complete code/commands.

**Type/name consistency:** `appScope(app, apps)` used identically in logs/groupby/stats/facets/events/jobs. `resolveScope` returns `{ ok, apps }`; handlers set `parsed.value.apps`. `validateProjectInput(raw, {partial})`, `createProject/updateProject(...,{now})`, `resolveProjectApps` → apps|null, `ensureProjectIndexes`, names match across tasks. `runJobs(collection, value, prefixes, {maxTimeMS})` matches its test and route call.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-21-timber-projects-backend.md`. (Plan 2, the Console, will be written after this backend lands, against the real API.)

Two execution options:
1. **Subagent-Driven (recommended)**, a fresh subagent per task, reviewed between tasks, fast iteration.
2. **Inline Execution**, execute tasks in this session via executing-plans, batched with checkpoints.

Which approach?
