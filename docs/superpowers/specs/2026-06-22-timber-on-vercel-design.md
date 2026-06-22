# Timber on Vercel — design spec

Date: 2026-06-22
Status: approved (storage = Neon Postgres, scope = full)

## 1. Goal

Re-host Timber as a single, fully Vercel-hosted Node.js log service: the existing
React Console (frontend) plus the `/v1/*` API (backend) as Vercel Serverless
Functions, backed by Neon serverless Postgres. Applications push logs over plain
REST (no SDK), and the Console renders every per-project lens already designed
(Errors, AI Usage, By User, By Service, Slow Operations, Cron and Jobs) plus the
global Stats and Explore views.

This replaces the Docker + self-hosted MongoDB deployment for the hosted use
case. The Docker/Mongo build stays in the repo as a separate artifact; it is not
removed by this work.

## 2. Why this fits, and the key constraint

The Console already calls a same-origin `/v1/*` API through a relative base URL
and only attaches the Bearer read key when the request resolves to its own
origin (`web/src/lib/api.ts`). Therefore:

- If the API is deployed as Vercel functions at the same origin under the same
  `/v1/*` paths, the frontend works essentially unchanged and the read key flows
  correctly.
- The hard constraint for the backend port is: **preserve the existing response
  shapes** defined in `web/src/lib/types.ts` and produced by the current
  `src/query/*` modules. The Mongo aggregation pipelines are reimplemented as SQL
  that returns the same JSON, so the Console needs no contract changes.

## 3. Architecture

One Vercel project, one origin:

- Frontend: the existing Vite + React 19 Console, built to `web/dist`.
- Backend: Vercel Serverless Functions (Node, ESM) serving the `/v1/*` contract
  plus a new ingest endpoint and a retention cron endpoint.
- Database: Neon serverless Postgres via `@neondatabase/serverless`. The `neon()`
  HTTP driver is used for queries and inserts (stateless per request, no pool to
  manage in serverless). `sql.transaction([...])` is used where a batch must be
  atomic.
- Retention: a daily Vercel Cron calls a protected function that deletes rows
  past their per-level TTL.

## 4. Repository and deployment layout

The existing Vercel project root is `web/` (evidenced by `web/vercel.json` and
`web/.vercelignore`). To keep the Console and API on one origin with no Vercel
dashboard changes, functions live under `web/api/`:

```
web/
  api/
    _lib/            # shared, non-routable (underscore prefix)
      db.js          # neon() client + helpers
      auth.js        # Bearer key check (write/read modes), ported from src/auth.js
      keys.js        # parse TIMBER_KEYS env
      respond.js     # JSON response + error helpers
      params.js      # query-param parsing shared across endpoints
      scope.js       # project -> app-glob resolution (ported from src/query/scope.js + projects.js)
      sql/           # SQL builders per lens (ported from src/query/*.js)
        logs.js
        stats.js
        facets.js
        groupby.js
        events.js
        jobs.js
    v1/
      logs.js        # GET (query) + POST (ingest)
      stats.js
      facets.js
      groupby.js
      events.js
      jobs.js
      projects.js    # GET/POST/PATCH/DELETE
    healthz.js
    cron/
      retention.js   # protected by CRON_SECRET; invoked daily by Vercel Cron
  vercel.json        # rewrites (/v1/* -> /api/v1/*), SPA fallback, crons
  package.json       # add @neondatabase/serverless (+ @vercel/node types as dev)
  src/ ...           # unchanged Console
```

If the operator instead sets the Vercel Root Directory to the repository root,
the same `api/` tree and `vercel.json` move up one level with no code change.

`vercel.json` (shape, exact values finalized in the plan):

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    { "source": "/v1/:path*", "destination": "/api/v1/:path*" },
    { "source": "/healthz", "destination": "/api/healthz" },
    { "source": "/((?!api/).*)", "destination": "/index.html" }
  ],
  "crons": [
    { "path": "/api/cron/retention", "schedule": "0 3 * * *" }
  ]
}
```

The SPA fallback must exclude `/api/*` (and the `/v1/*` and `/healthz` rewrites
are matched first) so API requests are never swallowed by `index.html`.

## 5. Data model (Neon Postgres)

```sql
CREATE TABLE IF NOT EXISTS events (
  id           BIGSERIAL PRIMARY KEY,
  ts           TIMESTAMPTZ NOT NULL,           -- event time (client-supplied or received_at)
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  app          TEXT NOT NULL,
  env          TEXT,
  service      TEXT,
  level        TEXT NOT NULL,                  -- debug|info|warn|error
  event        TEXT NOT NULL,
  message      TEXT,
  user_id      TEXT,
  request_id   TEXT,
  latency_ms   INTEGER,
  data         JSONB
);

CREATE INDEX IF NOT EXISTS idx_events_received_at ON events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_app_received ON events (app, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_level        ON events (level);
CREATE INDEX IF NOT EXISTS idx_events_service      ON events (service);
CREATE INDEX IF NOT EXISTS idx_events_user         ON events (user_id);
CREATE INDEX IF NOT EXISTS idx_events_event        ON events (event);

CREATE TABLE IF NOT EXISTS projects (
  slug        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  apps        TEXT[] NOT NULL DEFAULT '{}',    -- app globs, e.g. {"firehook","intervue-*"}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Project scoping: a `project=<slug>` param resolves the project's `apps` globs to
a set of app names and filters `events.app` accordingly. Glob resolution is
ported from `src/query/scope.js` and `src/projects.js`. Keyset pagination on
`/v1/logs` uses `(received_at, id)` as the cursor, mirroring the current Mongo
keyset cursor.

## 6. Endpoints

All preserve the current contract and JSON response shapes. Auth modes mirror
`src/auth.js`: writes require a write-mode key, reads require a read-mode key,
`/healthz` is open.

- `POST /v1/logs` (write) — NEW. Accepts one event or an array (bounded batch).
  Validates and normalizes via logic ported from `src/validate.js`, inserts via a
  single multi-row INSERT (or `sql.transaction` for a batch), returns `201` with
  `{ accepted, rejected }`. No WAL: the Postgres insert is the durability point.
- `GET /v1/logs` (read) — filter (`app, service, level, event, q, from, to,
  ids.*`) + keyset pagination; returns `{ items, nextCursor }` shape as today.
- `GET /v1/stats` (read) — overview aggregations (counts by level, throughput,
  error rate, top events/services), `project=` aware.
- `GET /v1/facets` (read) — facet counts (by service/level/app/event), powering
  filter chips and By Service / By User breakdowns.
- `GET /v1/groupby` (read) — generic grouping with metrics; powers By User, By
  Service, AI Usage (sums over `data` jsonb), Slow Operations (percentiles).
- `GET /v1/events` (read) — event catalog / distinct events.
- `GET /v1/jobs` (read) — cron and jobs rollups: per-job runs, success rate,
  durations, last run.
- `GET/POST/PATCH/DELETE /v1/projects` (read for GET, write for mutations) —
  projects CRUD over the `projects` table.
- `GET /healthz` — `{ ok, db: { connected }, ... }`.
- `GET /api/cron/retention` — protected by `CRON_SECRET`; deletes rows older than
  the per-level TTL. Not part of `/v1/*`; invoked only by Vercel Cron.

## 7. Per-project lenses to SQL

Each lens is an existing Console route calling stats/groupby/facets/logs/jobs
with `project=` plus a filter. SQL realizations:

- Errors: `WHERE level = 'error'`, grouped by `date_trunc(bucket, received_at)`,
  `event`, `service`.
- AI Usage: `SUM((data->>'promptTokens')::numeric)`, completion tokens, and
  `costUsd`, grouped by `data->>'model'`, `user_id`, and time bucket. Apps include
  `{ model, promptTokens, completionTokens, costUsd }` in `data`.
- By User: `GROUP BY user_id` with count, error count, last seen.
- By Service: `GROUP BY service` with the same metrics.
- Slow Operations: top-N by `latency_ms` plus
  `percentile_cont(0.5|0.95|0.99) WITHIN GROUP (ORDER BY latency_ms)`.
- Cron and Jobs: group by job identifier (event or `data->>'job'`), success vs
  failure counts, duration percentiles, last run, success rate.

All are native Postgres (GROUP BY, `date_trunc`, `percentile_cont`, jsonb
operators), so every lens survives the Mongo to SQL port.

## 8. Auth

Reuse the existing app-scoped key model. `TIMBER_KEYS` is a JSON array env var:
`[{ "key": "...", "app": "...", "env": "...", "mode": "write|read" }]`, parsed
once per cold start. The function checks `Authorization: Bearer <key>`: write
endpoints require `mode=write`, read endpoints require `mode=read`. The Console
continues to send the read key same-origin only. `DATABASE_URL` and
`CRON_SECRET` are the other env vars; all are set in the Vercel dashboard, never
committed.

## 9. Application integration (no SDK)

Apps POST to `https://<app>.vercel.app/v1/logs` with the write key. Two small
helpers are shipped (heartbeat filter + client-side batching, the same defenses
that prevented the earlier CPU flood):

- Python (`requests`) for firehook and intervue.
- JavaScript (`fetch`) for auto-assign.

For the AI Usage lens to populate, callers include
`{ model, promptTokens, completionTokens, costUsd }` in the event `data`.

## 10. Retention

A daily Vercel Cron (`0 3 * * *`) calls `/api/cron/retention`, which verifies
`Authorization: Bearer $CRON_SECRET` and runs level-based deletes: debug 7 days,
info 30 days, warn and error 90 days (configurable via env). This replaces
Mongo TTL indexes. Neon free tier storage stays bounded under this policy.

## 11. Trade-offs and non-goals

- No WAL / no 202 buffering: ingest writes straight to Postgres and returns 201.
  Durability is the committed row. Burst protection is the client heartbeat
  filter + batching, not a server-side WAL.
- Serverless cold start adds ~300 to 800 ms to the first request after idle.
  Acceptable for a logging UI.
- Retention is a daily sweep rather than continuous TTL.
- Non-goal: removing or migrating the existing Docker/Mongo server. It remains as
  a separate artifact.
- Non-goal: real-time push to the Console (it polls, as today).

## 12. Testing

- Unit: SQL builders in `web/api/_lib/sql/*` tested by asserting generated
  SQL + params for representative inputs (no DB needed), mirroring the current
  `parse*/run*` split.
- Integration: a Neon test branch (or a local Postgres) seeded with fixtures,
  asserting each endpoint returns the documented shape and that responses match
  the Console's TypeScript types. Gated like the current Mongo integration tests
  so CI without a database still passes.
- Frontend: the existing Vitest suite continues to pass unchanged (contract
  preserved). Add one test that the production `vercel.json` rewrites keep
  `/v1/*` and `/healthz` off the SPA fallback.

## 13. Rollout

1. Provision a Neon project + database; apply the schema; capture `DATABASE_URL`.
2. Add `DATABASE_URL`, `TIMBER_KEYS`, `CRON_SECRET`, and the retention env to the
   Vercel project.
3. Land the `web/api/*` functions, `vercel.json`, and the dependency.
4. Deploy; verify `/healthz`, a write to `/v1/logs`, and a read back through the
   Console.
5. Wire the three apps with the REST helpers (write key in each app's env).

## 14. Decisions (resolved)

- Storage: Neon serverless Postgres (`@neondatabase/serverless`, HTTP driver).
- Scope: full (ingest + all query endpoints + all six lenses + projects CRUD +
  retention cron + Console wired + deploy).
- Contract: unchanged `/v1/*` shapes so the Console is reused as-is.
