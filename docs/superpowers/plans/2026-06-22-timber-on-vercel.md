# Timber on Vercel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-host Timber fully on Vercel: the existing React Console plus the `/v1/*` API as Vercel Serverless Functions over Neon serverless Postgres, preserving every response shape so all six per-project lenses, stats, explore, projects, and jobs keep working, and adding a `POST /v1/logs` ingest endpoint apps push to over plain REST.

**Architecture:** One Vercel project, one origin. Functions live under `web/api/` (the current Vercel root). Each query endpoint keeps the existing `parse*Query` validation verbatim and swaps the Mongo aggregation builder for a SQL builder against Neon. The Neon HTTP driver (`neon()` tagged templates) is created at module scope and used per request (stateless, no pool). Retention runs as a daily Vercel Cron. The Console is unchanged because it already calls same-origin `/v1/*` with the read key gated to its own origin.

**Tech Stack:** Node 22 (ESM) Vercel Functions, `@neondatabase/serverless`, Neon Postgres, Vite + React 19 Console (existing), `node:test` for builder unit tests.

---

## Conventions ported from the Mongo server (authoritative)

These are fixed by the existing contract (`web/src/lib/types.ts`, `src/validate.js`, `src/query/*`). The SQL port MUST preserve them.

- Envelope allowed keys: `event, level, ts, message, ids, data`. `event` required (<=200 chars, no control chars). `level` in `debug|info|warn|error`, default `info`. `message` truncated to 512 chars. `ids` plain object (<=10 keys, values stringified). `data` plain object, depth <=32, JSON serialized; if >16384 bytes it is replaced by `{_truncated:true,_originalBytes,_head}`.
- A "service" is the per-key `app`. There is no separate service field. "By Service" is `groupby?by=app`.
- "By User" is `groupby?by=ids.userId` (or `data.userId`) sent by the Console; groupby must support any `ids.*`/`data.*` path.
- AI-usage fields live in `data`: `costUsd`, `inputTokens`, `outputTokens`. Latency is `data.latencyMs` then `data.durationMs`. HTTP error rate counts `data.status >= 400` over rows where `data.status` is numeric.
- `_id` in responses is the row id as a string. Keyset order is `received_at DESC, id DESC`; the cursor carries `{receivedAt, id}`.
- `expiresAt` per row = `received_at + ttlDays[level]` (debug 7, info 30, warn 90, error 90). Retention deletes `expires_at < now()`.

## Database schema (Neon Postgres)

```sql
CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  app         TEXT NOT NULL,
  env         TEXT NOT NULL DEFAULT '',
  event       TEXT NOT NULL,
  level       TEXT NOT NULL DEFAULT 'info',
  ts          TIMESTAMPTZ,
  message     TEXT,
  ids         JSONB,
  data        JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_received ON events (received_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_events_app_recv ON events (app, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_level    ON events (level);
CREATE INDEX IF NOT EXISTS idx_events_event    ON events (event text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_events_expires  ON events (expires_at);
CREATE INDEX IF NOT EXISTS idx_events_data_gin ON events USING GIN (data);
CREATE INDEX IF NOT EXISTS idx_events_ids_gin  ON events USING GIN (ids);

CREATE TABLE IF NOT EXISTS projects (
  slug       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  name_lower TEXT NOT NULL UNIQUE,
  apps       TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## File structure

```
web/
  api/
    _lib/
      env.js        # parse TIMBER_KEYS, TTL days, limits, CRON_SECRET from process.env
      db.js         # neon() client (module scope) + small helpers
      keyring.js    # createKeyring/canRead/canWrite, ported verbatim from src/auth.js
      auth.js       # requireRead(req)/requireWrite(req) -> principal | sends 401
      respond.js    # json(res,status,body), badRequest, etc.
      cursor.js     # encodeCursor/decodeCursor for {receivedAt,id}
      validate.js   # validateBatch/validateEnvelope, ported from src/validate.js (drop deriveId/enrich)
      where.js      # buildWhere(searchParams) -> {sql, params, value}  (port of buildLogsFilter)
      scope.js      # appScopeSql(app, apps, params) -> sql fragment + pushes params
      projects.js   # SQL CRUD + resolveProjectApps
      sql/
        logs.js     # parseLogsQuery (verbatim) + buildLogsSql + runLogs
        stats.js    # parseStatsQuery (verbatim) + buildStatsSql + runStats
        groupby.js  # parseGroupByQuery (verbatim) + buildGroupBySql + runGroupBy
        facets.js   # parseFacetsQuery (verbatim) + runFacets
        events.js   # parseEventsQuery (verbatim) + runEvents
        jobs.js     # parseJobsQuery (verbatim) + buildJobsSql + runJobs
    v1/
      logs.js       # GET=query, POST=ingest
      stats.js
      groupby.js
      facets.js
      events.js
      jobs.js
      projects.js   # GET/POST/PATCH/DELETE
    healthz.js
    cron/
      retention.js
  vercel.json       # rewrites + crons
  package.json      # + @neondatabase/serverless
test/api/           # node:test unit tests for builders (no DB)
```

If the Vercel Root Directory is the repo root instead of `web/`, move `api/`, `vercel.json`, and the dependency up one level. No code changes.

---

## Task 1: Provision Neon + apply schema

**Files:** none (infrastructure). Output: `DATABASE_URL` set in Vercel.

- [ ] **Step 1: Create the Neon project + database** via the Neon tooling (MCP `create_project`), region near the Vercel functions (iad1 / us-east).
- [ ] **Step 2: Apply the schema** above (MCP `run_sql`), both tables + all indexes.
- [ ] **Step 3: Capture the pooled connection string** (`get_connection_string`). Hand the operator the value to set as `DATABASE_URL` in Vercel (Production + Preview). Never commit it.
- [ ] **Step 4: Smoke test** `SELECT 1` and `INSERT ... RETURNING id` then `DELETE` to confirm write + read.

Expected: two tables exist; a round-trip insert/select/delete succeeds.

---

## Task 2: Dependencies + shared library

**Files:** Create `web/api/_lib/{env,db,keyring,auth,respond,cursor,validate}.js`; Modify `web/package.json`; Test `test/api/lib.test.js`.

- [ ] **Step 1: Add the dependency.** In `web/package.json` add to `dependencies`: `"@neondatabase/serverless": "^0.10.0"`. Run `npm install` in `web/`.

- [ ] **Step 2: `web/api/_lib/db.js`** (module-scope HTTP client, per Context7 Neon docs):

```js
import { neon } from '@neondatabase/serverless';

// HTTP driver: stateless per query, safe to create once per cold start.
export const sql = neon(process.env.DATABASE_URL);

// Parameterized escape hatch for dynamically-built statements.
export const query = (text, params) => sql.query(text, params);
```

- [ ] **Step 3: `web/api/_lib/env.js`** parse config from `process.env`:

```js
const num = (v, d) => (v != null && /^\d+$/.test(v) ? Number(v) : d);

export function loadKeys() {
  try {
    const arr = JSON.parse(process.env.TIMBER_KEYS ?? '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export const ttlDays = () => ({
  debug: num(process.env.TIMBER_TTL_DEBUG_DAYS, 7),
  info:  num(process.env.TIMBER_TTL_INFO_DAYS, 30),
  warn:  num(process.env.TIMBER_TTL_WARN_DAYS, 90),
  error: num(process.env.TIMBER_TTL_ERROR_DAYS, 90),
});

export const limits = () => ({
  maxBatch: num(process.env.TIMBER_MAX_BATCH, 500),
  maxMessageChars: 512, maxIdsKeys: 10, maxDataBytes: 16_384, maxDataDepth: 32,
});

export const cronSecret = () => process.env.CRON_SECRET ?? '';
```

- [ ] **Step 4: `web/api/_lib/keyring.js`** — copy `src/auth.js` verbatim (it has no Mongo dependency): `createKeyring`, `canWrite`, `canRead`.

- [ ] **Step 5: `web/api/_lib/respond.js`**:

```js
export const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};
export const badRequest = (res, error) => json(res, 400, { error });
```

- [ ] **Step 6: `web/api/_lib/auth.js`**:

```js
import { createKeyring, canRead, canWrite } from './keyring.js';
import { loadKeys } from './env.js';
import { json } from './respond.js';

let ring;
const keyring = () => (ring ??= createKeyring(loadKeys()));

export function requireRead(req, res) {
  const p = keyring().authenticate(req.headers.authorization);
  if (!canRead(p)) { json(res, 401, { error: 'unauthorized' }); return null; }
  return p;
}
export function requireWrite(req, res) {
  const p = keyring().authenticate(req.headers.authorization);
  if (!canWrite(p)) { json(res, 401, { error: 'unauthorized' }); return null; }
  return p;
}
```

- [ ] **Step 7: `web/api/_lib/cursor.js`** (base64url of `receivedAtMs:id`):

```js
export function encodeCursor({ receivedAt, id }) {
  const ms = receivedAt instanceof Date ? receivedAt.getTime() : Date.parse(receivedAt);
  return Buffer.from(`${ms}:${id}`, 'utf8').toString('base64url');
}
export function decodeCursor(s) {
  try {
    const [ms, id] = Buffer.from(s, 'base64url').toString('utf8').split(':');
    if (!/^\d+$/.test(ms) || !/^\d+$/.test(id)) return null;
    return { receivedAt: new Date(Number(ms)), id: Number(id) };
  } catch { return null; }
}
```

- [ ] **Step 8: `web/api/_lib/validate.js`** — copy `validateEnvelope` and `validateBatch` from `src/validate.js` verbatim, plus `LEVELS`. Drop `deriveId`/`enrich` (Postgres assigns the id; enrichment happens in the ingest handler).

- [ ] **Step 9: Test** `test/api/lib.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCursor, decodeCursor } from '../../web/api/_lib/cursor.js';
import { createKeyring, canRead, canWrite } from '../../web/api/_lib/keyring.js';

test('cursor round-trips', () => {
  const c = { receivedAt: new Date('2026-06-22T00:00:00Z'), id: 42 };
  const back = decodeCursor(encodeCursor(c));
  assert.equal(back.id, 42);
  assert.equal(back.receivedAt.getTime(), c.receivedAt.getTime());
});
test('decodeCursor rejects garbage', () => assert.equal(decodeCursor('!!'), null));
test('keyring authenticates + scopes mode', () => {
  const ring = createKeyring([{ key: 'w', app: 'a', env: 'prod', mode: 'write' }]);
  assert.equal(canWrite(ring.authenticate('Bearer w')), true);
  assert.equal(canRead(ring.authenticate('Bearer w')), true);
  assert.equal(ring.authenticate('Bearer nope'), null);
});
```

- [ ] **Step 10: Run** `node --test test/api/lib.test.js` -> PASS. **Commit** `feat(vercel): shared api lib (db, auth, cursor, validate, env)`.

---

## Task 3: Ingest — `POST /v1/logs`

**Files:** Create `web/api/v1/logs.js` (POST half); Test `test/api/ingest.test.js`.

The handler: auth write -> read JSON body -> `validateBatch` -> enrich each row (app/env from the key principal, `received_at = now`, `expires_at` from level TTL) -> one multi-row INSERT -> `201 { accepted, rejected }`.

- [ ] **Step 1: Write `web/api/v1/logs.js` POST path:**

```js
import { sql } from '../_lib/db.js';
import { requireWrite, requireRead } from '../_lib/auth.js';
import { json, badRequest } from '../_lib/respond.js';
import { validateBatch } from '../_lib/validate.js';
import { ttlDays, limits } from '../_lib/env.js';

const DAY_MS = 86_400_000;

async function ingest(req, res) {
  const p = requireWrite(req, res); if (!p) return;
  const lim = limits();
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return badRequest(res, 'invalid JSON'); } }
  const v = validateBatch(body, lim);
  if (!v.ok) return json(res, v.status ?? 400, { error: v.error, index: v.index });

  const ttl = ttlDays();
  const now = new Date();
  const rows = v.events.map((e) => ({
    app: p.app, env: p.env ?? '', event: e.event, level: e.level,
    ts: e.ts ?? null, message: e.message ?? null,
    ids: e.ids ?? null, data: e.data ?? null,
    received_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl[e.level] * DAY_MS).toISOString(),
  }));

  // Single multi-row insert via unnest of typed arrays (one round trip).
  await sql`
    INSERT INTO events (app, env, event, level, ts, message, ids, data, received_at, expires_at)
    SELECT * FROM unnest(
      ${rows.map(r => r.app)}::text[], ${rows.map(r => r.env)}::text[],
      ${rows.map(r => r.event)}::text[], ${rows.map(r => r.level)}::text[],
      ${rows.map(r => r.ts)}::timestamptz[], ${rows.map(r => r.message)}::text[],
      ${rows.map(r => r.ids == null ? null : JSON.stringify(r.ids))}::jsonb[],
      ${rows.map(r => r.data == null ? null : JSON.stringify(r.data))}::jsonb[],
      ${rows.map(r => r.received_at)}::timestamptz[], ${rows.map(r => r.expires_at)}::timestamptz[]
    )`;
  return json(res, 201, { accepted: rows.length, rejected: 0 });
}

export default async function handler(req, res) {
  if (req.method === 'POST') return ingest(req, res);
  if (req.method === 'GET') return query(req, res); // implemented in Task 4
  res.setHeader('allow', 'GET, POST');
  return json(res, 405, { error: 'method not allowed' });
}
```

- [ ] **Step 2: Test the enrich/validate seam** in `test/api/ingest.test.js` by importing `validateBatch` and asserting: a missing `event` returns `{ok:false,status:400,index:0}`; a batch over `maxBatch` returns status 413; a valid mixed batch returns normalized events with `level` defaulted to `info`. (The INSERT itself is covered by the integration smoke in Task 14; unit tests stay DB-free.)

- [ ] **Step 3: Run** `node --test test/api/ingest.test.js` -> PASS. **Commit** `feat(vercel): POST /v1/logs ingest into Neon`.

---

## Task 4: Query — `GET /v1/logs` (filter + keyset)

**Files:** Create `web/api/_lib/where.js`, `web/api/_lib/scope.js`, `web/api/_lib/sql/logs.js`; Modify `web/api/v1/logs.js` (GET path); Test `test/api/where.test.js`.

`where.js` is the port of `buildLogsFilter`: same param surface and validation (copy `hasCatastrophicBacktracking`, `parseDateValue`, numeric coercion, inverted-window check verbatim), but it emits SQL clauses + a positional params array instead of a Mongo filter. Mapping table:

| Param | Mongo | SQL clause (params pushed) |
|------|-------|-----|
| `app`,`env` | `{app:v}` | `app = $n` |
| `level` (CSV) | `{$in}` | `level = ANY($n)` (text[]) |
| `event` | `{$regex:'^'+esc}` | `event LIKE $n` with `esc(value)||'%'` (escape `%_\`) |
| `from`/`to` | receivedAt range | `received_at >= $n` / `received_at < $n` |
| `q` | `{message:{$regex,i}}` | `message ~* $n` (ReDoS guard kept) |
| `ids.X` | `{'ids.X':v}` | `ids->>'X' = $n` |
| `data.X` | eq (coerced) | `data->>'X' = $n` (jsonb ->> is text; numeric stored matches its text form) |
| `data.X__gte/__lte` | range | `(data->>'X')::numeric >= $n` / `<= $n` |
| `cursor` | keyset `$or` | `(received_at < $a OR (received_at = $a AND id < $b))` |

`buildWhere(searchParams)` returns `{ clauses: string[], params: any[], value: { limit } }`. A helper composes `WHERE ` + `clauses.join(' AND ')` (or empty).

`scope.js` `appScopeSql(app, apps)` returns `{ clause, params }`: `app = $n` for a single app, `app = ANY($n)` for a project app list, `false` for an empty/ non-member set, `null` for no constraint.

- [ ] **Step 1: Write `where.js`** porting `buildLogsFilter` to the table above. Keep `MAX_Q_CHARS`, the `hasCatastrophicBacktracking` guard, `parseDateValue`, and the inverted-window 400 verbatim.

- [ ] **Step 2: Write `sql/logs.js`:** `parseLogsQuery` copied verbatim (it only adds the `limit` clamp on top of the shared builder). `buildLogsSql(value, scope)` ->

```sql
SELECT id, app, env, event, level, ts, message, ids, data, received_at, expires_at
FROM events
WHERE <clauses [AND scope]>
ORDER BY received_at DESC, id DESC
LIMIT <limit + 1>
```

`runLogs` executes via `sql.query(text, params)`, takes the extra row to compute `nextCursor`, and maps each row to a `LogDoc`: `_id: String(id)`, `receivedAt: received_at.toISOString()`, `expiresAt: expires_at.toISOString()`, `ts`/`message`/`ids`/`data` only when non-null. Returns `{ items, nextCursor }` (cursor from the last visible row when a 1-extra row was fetched, else null).

- [ ] **Step 3: Wire the GET path** `query(req,res)` in `web/api/v1/logs.js`: `requireRead`; strip `project` (resolve via `resolveProjectApps` -> scope); `parseLogsQuery`; on `!ok` -> 400; else `runLogs`; `json(res,200,result)`.

- [ ] **Step 4: Test `test/api/where.test.js`** (pure, no DB): assert `buildWhere` for representative inputs produces the expected clause + params, e.g.:

```js
import { buildWhere } from '../../web/api/_lib/where.js';
const r = buildWhere(new URLSearchParams('app=firehook&level=warn,error&data.status__gte=400'));
assert.deepEqual(r.clauses, ['app = $1', 'level = ANY($2)', '(data->>\'status\')::numeric >= $3']);
assert.deepEqual(r.params, ['firehook', ['warn','error'], 400]);
```
Add cases: unknown param -> `{ok:false}`; inverted window -> error; a catastrophic `q` like `(a+)+` -> rejected; a cursor param -> the keyset clause + 2 params.

- [ ] **Step 5: Run** `node --test test/api/where.test.js` -> PASS. **Commit** `feat(vercel): GET /v1/logs filter + keyset over Neon`.

---

## Task 5: `GET /v1/stats`

**Files:** Create `web/api/_lib/sql/stats.js`, `web/api/v1/stats.js`; Test `test/api/stats.test.js`.

`parseStatsQuery` copied verbatim. `buildStatsSql({group,from,to,app,event,apps})`:

```sql
SELECT
  date_trunc($group, received_at) AS bucket,
  count(*)                                         AS total,
  count(*) FILTER (WHERE level='debug')            AS debug,
  count(*) FILTER (WHERE level='info')             AS info,
  count(*) FILTER (WHERE level='warn')             AS warn,
  count(*) FILTER (WHERE level='error')            AS error,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY (coalesce(data->>'latencyMs', data->>'durationMs'))::float8) AS p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (coalesce(data->>'latencyMs', data->>'durationMs'))::float8) AS p95,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY (coalesce(data->>'latencyMs', data->>'durationMs'))::float8) AS p99,
  count(*) FILTER (WHERE (data->>'status') ~ '^\d+$')                          AS status_total,
  count(*) FILTER (WHERE (data->>'status') ~ '^\d+$' AND (data->>'status')::int >= 400) AS status_errors,
  coalesce(sum((data->>'costUsd')::float8)      FILTER (WHERE (data->>'costUsd')      ~ '^-?\d+(\.\d+)?$'), 0) AS cost_usd,
  coalesce(sum((data->>'inputTokens')::float8)  FILTER (WHERE (data->>'inputTokens')  ~ '^-?\d+(\.\d+)?$'), 0) AS input_tokens,
  coalesce(sum((data->>'outputTokens')::float8) FILTER (WHERE (data->>'outputTokens') ~ '^-?\d+(\.\d+)?$'), 0) AS output_tokens
FROM events
WHERE received_at >= $from AND received_at < $to [AND <scope>] [AND event LIKE $eventPrefix]
GROUP BY bucket
ORDER BY bucket ASC
```

Note the numeric-regex `FILTER` guards mirror Mongo's `$convert ... onError:null` (non-numeric values are excluded from percentile/sum, not coerced to 0 wrongly). `runStats` maps each row to a `StatsBucket`: `bucket` ISO, `counts`, `latency: p50==null?null:{p50,p95,p99}`, `errorRate: status_total? status_errors/status_total : null`, `costUsd` rounded to 6 dp, `inputTokens`, `outputTokens`. Returns `{group, from, to, buckets}`.

- [ ] **Step 1:** Write `sql/stats.js` (parse verbatim + buildStatsSql + runStats mapping above).
- [ ] **Step 2:** Write `web/api/v1/stats.js`: `requireRead`; resolve `project`->scope; `parseStatsQuery`; run; respond.
- [ ] **Step 3: Test** `test/api/stats.test.js`: assert `buildStatsSql` emits `date_trunc('hour', ...)`, three `percentile_cont`, and the cost/token sums; assert `runStats` mapping turns a fake row into the exact `StatsBucket` shape (latency null when p50 null; errorRate null when status_total 0; costUsd rounded).
- [ ] **Step 4: Run** -> PASS. **Commit** `feat(vercel): GET /v1/stats (date_trunc + percentile_cont)`.

---

## Task 6: `GET /v1/groupby`

**Files:** Create `web/api/_lib/sql/groupby.js`, `web/api/v1/groupby.js`; Test `test/api/groupby.test.js`.

`parseGroupByQuery` copied verbatim (BY_RE whitelist, 24h default window, reuses `buildWhere` for the filter surface, `like`, limit clamp). Translate `by` to a SQL grouping expression with the SAME whitelist so no injection: `app|env|level|event` -> column; `ids.X` -> `ids->>'X'`; `data.X` -> `data->>'X'`.

```sql
WITH g AS (
  SELECT <byExpr> AS value, count(*) AS count
  FROM events WHERE <clauses [AND scope]>
  GROUP BY <byExpr>
  [HAVING <byExpr> ~* $like]
)
SELECT value, count FROM g ORDER BY count DESC, value ASC LIMIT $limit;  -- groups
SELECT coalesce(sum(count),0) AS total FROM g;                            -- total
```

Run both in one `sql.transaction([...])`. `otherCount = max(0, total - sum(shown counts))`. Map to `{by, total, groups:[{value,count}], otherCount, window:{from,to}}`. Cast `count` to Number.

- [ ] **Step 1:** Write `sql/groupby.js` (parse verbatim; `byExpr` via the whitelist switch; the CTE query; transaction; mapping).
- [ ] **Step 2:** Write `web/api/v1/groupby.js`: `requireRead`; resolve `project`->scope; parse; run; respond.
- [ ] **Step 3: Test:** `by=app` -> `GROUP BY app`; `by=ids.userId` -> `GROUP BY ids->>'userId'`; invalid `by=$where` -> 400; `otherCount` computed from total minus shown.
- [ ] **Step 4: Run** -> PASS. **Commit** `feat(vercel): GET /v1/groupby (By User / By Service / AI model)`.

---

## Task 7: `GET /v1/facets`

**Files:** Create `web/api/_lib/sql/facets.js`, `web/api/v1/facets.js`; Test `test/api/facets.test.js`.

`parseFacetsQuery` verbatim. SQL discovers distinct jsonb keys in the window:

```sql
SELECT 'ids' AS kind, jsonb_object_keys(ids) AS k FROM events
  WHERE received_at >= $from AND received_at < $to [AND <scope>] AND ids IS NOT NULL
UNION
SELECT 'data' AS kind, jsonb_object_keys(data) AS k FROM events
  WHERE received_at >= $from AND received_at < $to [AND <scope>] AND data IS NOT NULL;
```

`runFacets` splits rows by `kind`, sorts each set, returns `{window:{from,to}, idsKeys, dataPaths}`.

- [ ] **Step 1:** Write `sql/facets.js`. **Step 2:** Write `web/api/v1/facets.js`. **Step 3:** Test the row->`{idsKeys,dataPaths}` split + sort + window echo. **Step 4: Run** -> PASS. **Commit** `feat(vercel): GET /v1/facets (jsonb_object_keys)`.

---

## Task 8: `GET /v1/events`

**Files:** Create `web/api/_lib/sql/events.js`, `web/api/v1/events.js`; Test `test/api/events.test.js`.

`parseEventsQuery` verbatim. SQL:

```sql
SELECT app, event FROM events [WHERE <scope>] GROUP BY app, event ORDER BY app ASC, event ASC;
```

`runEvents` folds rows into `{ apps: { [app]: [event, ...] } }` (events sorted).

- [ ] **Step 1:** Write `sql/events.js`. **Step 2:** Write `web/api/v1/events.js`. **Step 3:** Test the fold to `{apps:{...}}`. **Step 4: Run** -> PASS. **Commit** `feat(vercel): GET /v1/events`.

---

## Task 9: `GET /v1/jobs`

**Files:** Create `web/api/_lib/sql/jobs.js`, `web/api/v1/jobs.js`; Test `test/api/jobs.test.js`.

`parseJobsQuery` verbatim (from/to default 24h, optional `app`). Prefix set default `['cron.']` (env `TIMBER_JOB_PREFIXES`). SQL:

```sql
SELECT
  event AS name,
  count(*) AS runs,
  count(*) FILTER (WHERE level='error'
    OR lower(coalesce(data->>'status','')) IN ('error','failed','failure')) AS failures,
  max(received_at) AS last_run_at,
  (array_agg(level ORDER BY received_at DESC))[1]            AS last_level,
  (array_agg(data->>'status' ORDER BY received_at DESC))[1]  AS last_status_raw,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY (data->>'latencyMs')::float8) AS p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY (data->>'latencyMs')::float8) AS p95
FROM events
WHERE received_at >= $from AND received_at < $to
  AND (event LIKE $p1 [OR event LIKE $p2 ...]) [AND <scope>]
GROUP BY event
ORDER BY runs DESC, name ASC
LIMIT 200;
```

`runJobs` maps each row to a `JobRow`: `lastStatus` = failed when `last_level='error'` or `last_status_raw` in {error,failed,failure} else ok; `successRate = round((runs-failures)/runs, 4)`; `p50Ms`/`p95Ms` null when null; `lastRunAt` ISO. Returns `{jobs, window:{from,to}}`.

- [ ] **Step 1:** Write `sql/jobs.js`. **Step 2:** Write `web/api/v1/jobs.js`. **Step 3:** Test the row->`JobRow` mapping (failed detection, successRate rounding to 4 dp, null percentiles). **Step 4: Run** -> PASS. **Commit** `feat(vercel): GET /v1/jobs rollups`.

---

## Task 10: `/v1/projects` CRUD + scope resolution

**Files:** Create `web/api/_lib/projects.js`, `web/api/v1/projects.js`; Test `test/api/projects.test.js`.

Port `validateProjectInput`, `slugify`, `toView` verbatim from `src/projects.js`. SQL versions:

- `listProjects()` -> `SELECT slug,name,apps FROM projects ORDER BY name_lower ASC` -> `{projects:[{slug,name,apps}]}`.
- `createProject(input)` -> compute unique slug (`SELECT 1 FROM projects WHERE slug=$1` loop), `INSERT ... ON CONFLICT (name_lower) DO NOTHING RETURNING slug,name,apps`; null return -> `{conflict:true}`.
- `updateProject(slug, patch)` -> `UPDATE projects SET name=coalesce($,name), name_lower=..., apps=coalesce($,apps), updated_at=now() WHERE slug=$ RETURNING ...`; no row -> `{notFound:true}`; unique violation -> `{conflict:true}`.
- `deleteProject(slug)` -> `DELETE ... WHERE slug=$ RETURNING slug` -> boolean.
- `resolveProjectApps(slug)` -> `SELECT apps FROM projects WHERE slug=$1` -> array or null.

Handler `web/api/v1/projects.js` dispatches by method: GET `requireRead` -> list; POST/PATCH/DELETE `requireWrite` -> validate -> CRUD -> map results to status codes (201 create, 200 patch, 204 delete, 404 notFound, 409 conflict, 400 invalid). DELETE reads `slug` from the query string.

- [ ] **Step 1:** Write `web/api/_lib/projects.js`. **Step 2:** Write `web/api/v1/projects.js`. **Step 3: Test** `validateProjectInput` (verbatim behavior: unknown key, name required on create, apps dedup) and `slugify`. **Step 4: Run** -> PASS. **Commit** `feat(vercel): /v1/projects CRUD + project scoping`.

Project scoping wiring (apply to Tasks 4-9 handlers): each read handler, before parsing, pops `project` from the query params; if present, `apps = await resolveProjectApps(project)`; `apps===null` -> still proceed with `apps=[]` (unknown project -> empty scope -> no rows), matching the Mongo `appScope(_, [])` semantics; pass `apps` into the scope SQL.

---

## Task 11: `GET /healthz`

**Files:** Create `web/api/healthz.js`.

Preserve the existing `Health` shape so the Console health view is unchanged. Map the serverless reality onto it: WAL fields zeroed, flusher synthetic, `mongo.connected` reflects Postgres reachability.

```js
import { sql } from './_lib/db.js';
import { json } from './_lib/respond.js';

export default async function handler(_req, res) {
  let connected = false, count = 0;
  try { const r = await sql`SELECT count(*)::int AS n FROM events`; count = r[0].n; connected = true; } catch {}
  json(res, 200, {
    ok: connected,
    wal: { totalBytes: 0, backlogBytes: 0, overBudget: false },
    flusher: { running: true, caughtUp: true, flushedTotal: count, lastError: null },
    mongo: { connected },
  });
}
```

- [ ] **Step 1:** Write it. **Step 2:** `curl /healthz` returns the shape (verified in Task 14). **Commit** `feat(vercel): /healthz adapted to Postgres`.

---

## Task 12: Retention cron + vercel.json

**Files:** Create `web/api/cron/retention.js`; Modify `web/vercel.json`.

- [ ] **Step 1: `web/api/cron/retention.js`** (secured per Context7 Vercel cron docs):

```js
import { sql } from '../_lib/db.js';
import { json } from '../_lib/respond.js';
import { cronSecret } from '../_lib/env.js';

export default async function handler(req, res) {
  const secret = cronSecret();
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return json(res, 401, { ok: false });
  const r = await sql`DELETE FROM events WHERE expires_at < now()`;
  json(res, 200, { ok: true, deleted: r.count ?? null });
}
```

- [ ] **Step 2: `web/vercel.json`** — rewrites map `/v1/*` and `/healthz` to functions and keep the SPA fallback off the API; add the daily cron:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    { "source": "/v1/:path*", "destination": "/api/v1/:path*" },
    { "source": "/healthz", "destination": "/api/healthz" },
    { "source": "/((?!api/|v1/|healthz).*)", "destination": "/index.html" }
  ],
  "crons": [
    { "path": "/api/cron/retention", "schedule": "0 3 * * *" }
  ]
}
```

- [ ] **Step 3:** Add `CRON_SECRET` to Vercel env (operator). **Commit** `feat(vercel): retention cron + routing`.

---

## Task 13: REST client helpers (apps)

**Files:** Create `clients/timber_client.py`, `clients/timber-client.js`, `clients/README.md`.

Both buffer, batch (<=100), drop heartbeat noise (`/no message \(still listening\)/i`, `/heartbeat/i`, the hourglass char), gate on `LOG_MIN_LEVEL`, and POST to `${TIMBER_URL}/v1/logs` with `Authorization: Bearer ${TIMBER_WRITE_KEY}`. For AI usage, callers put `costUsd/inputTokens/outputTokens` (and `latencyMs`, `status`) in `data`.

- [ ] **Step 1:** Write the Python helper (`requests`, background flush thread, `log(event, level=..., message=..., ids=..., data=...)` + `flush()`).
- [ ] **Step 2:** Write the JS helper (`fetch`, timer flush, same API).
- [ ] **Step 3:** Write `clients/README.md` with copy-paste setup for firehook, intervue (Python), auto-assign (Node), including the env vars and the heartbeat-filter note (the earlier CPU-flood lesson).
- [ ] **Step 4: Commit** `docs(vercel): Python + JS log client helpers`.

---

## Task 14: Build, deploy, verify end-to-end

**Files:** Modify `web/vercel.json` only if needed; no code.

- [ ] **Step 1:** Run the Console build locally: `cd web && npm run build` -> succeeds (functions are not part of the Vite build; they deploy separately).
- [ ] **Step 2:** Run the full builder suite: `node --test "test/api/**/*.test.js"` -> all PASS. Run the existing web suite `cd web && npm test` -> unchanged PASS.
- [ ] **Step 3:** Confirm env in Vercel: `DATABASE_URL`, `TIMBER_KEYS`, `CRON_SECRET` (Production + Preview). Deploy (push the branch -> Vercel preview, or `vercel deploy`).
- [ ] **Step 4: Smoke the deployment:**
  - `GET /healthz` -> `{ ok: true, mongo: { connected: true } }`.
  - `POST /v1/logs` with the write key + a sample event -> `201 { accepted: 1 }`.
  - `GET /v1/logs` with the read key -> the event back, `_id` a string, `receivedAt` ISO.
  - `GET /v1/stats?group=hour` -> a bucket with the event counted.
- [ ] **Step 5:** Open the Console on the deployment, set the read key in Settings, confirm Stats/Explore/Projects render and a project's lenses (Errors, By User, By Service via `by=app`, AI Usage, Slow Operations, Cron and Jobs) return data.
- [ ] **Step 6: Commit** any config fix. Tag the working deployment.

---

## Self-review notes

- Spec coverage: ingest (T3), all `/v1/*` query endpoints (T4-T10), projects CRUD + scoping (T10), healthz (T11), retention cron + routing (T12), app integration (T13), deploy/verify (T14), Neon provisioning + schema (T1), shared lib (T2). All spec sections map to a task.
- Shapes verified against `web/src/lib/types.ts`: LogsResponse, StatsResponse/StatsBucket, GroupByResponse, FacetsResponse, EventsResponse, JobsResponse/JobRow, ProjectsResponse/Project, Health.
- The `parse*Query` functions are reused verbatim, so the param-validation contract (unknown-param 400s, inverted-window 400s, level whitelist, BY_RE) is identical to the Mongo server with zero re-derivation.
- Naming consistency: `buildWhere`, `appScopeSql`, `resolveProjectApps`, `buildLogsSql/buildStatsSql/buildGroupBySql/buildJobsSql`, `runLogs/runStats/...` are used consistently across tasks.
