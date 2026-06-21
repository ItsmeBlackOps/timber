# Timber, Projects & per-project lenses (design)

**Date:** 2026-06-21
**Status:** Approved decisions; pending spec review → implementation plan
**Branch:** `feat/timber-console`

## 1. Summary

Add a **Project** scope to Timber. A project is a named grouping of existing
**services** (the per-key `app` value). Selecting a project scopes the whole
Console, and the six existing lenses, to that project's services, and adds a
richer **Cron & Jobs** dashboard. Projects are stored server-side and shared
across everyone using the Console.

This is an **overlay** on the current data model: events are unchanged, so it
works retroactively on all existing logs. The six lenses already exist
(`web/src/lib/views.ts` → `BUILTIN_LENSES`: `errors`, `ai-usage`, `by-user`,
`by-service`, `slow-ops`, `cron`); the new work is the project scope layer, the
projects registry, and the jobs view.

## 2. Locked decisions

| Decision | Choice |
|---|---|
| What a project is | A **named set of services** (member `app` values). |
| Where projects live | **Server-side, shared**, a Mongo collection + CRUD API. |
| Cron & Jobs depth | **Both**, keep the scoped `cron.*` lens **and** add a jobs dashboard backed by a new endpoint. |
| Who can edit projects | **Any valid key** (`canRead`), list and mutate. The Console's existing read key can add/edit/delete. |

## 3. Background (current state, verified)

- **Service & env are key-derived.** `POST /v1/logs` stamps `app: principal.app,
  env: principal.env` from the authenticating key via `enrich()`
  (`src/server.js:172`, `src/auth.js:26`). Clients cannot spoof them.
- **Read endpoints:** `/v1/logs`, `/v1/stats`, `/v1/events`, `/v1/facets`,
  `/v1/groupby` (+ `/healthz`). Auth: `canRead` = read **or** write key;
  `canWrite` = write key (`src/auth.js:33`).
- **Console** is a TanStack-Router SPA, read-only, key in `localStorage`,
  same-origin relative API calls. Filters live in the URL. `AppSwitcher`
  (`web/src/components/AppSwitcher.tsx`) scopes to one `app` (from
  `/v1/events` apps) or "all apps". Lenses + saved views are client-side
  (`web/src/lib/views.ts`).

## 4. Data model

New Mongo collection, name from `TIMBER_PROJECTS_COLLECTION` (default
`projects`):

```jsonc
{
  "_id":  "<ObjectId>",
  "name": "Acme Platform",       // unique (case-insensitive), trimmed, 1..80 chars
  "slug": "acme-platform",       // derived from name at creation; unique; immutable
  "apps": ["web", "api", "worker"], // member service names; 0..200, each 1..128 chars
  "createdAt": "<ISO>",
  "updatedAt": "<ISO>"
}
```

- **No change to event documents.** A project is resolved to its `apps` and
  applied as a filter at query time.
- Indexes: unique on `slug`; unique (case-insensitive) on `name`.
- `name` is editable (display); `slug` is stable so shared URLs don't break on
  rename.

## 5. Server, Projects CRUD API

All gated by `canRead` (per decision). All validated with the rigor of
`src/validate.js` (explicit shape checks, length/array caps, reject unknown
top-level keys). Reads honor `queryMaxTimeMs`.

| Method | Path | Body / params | Returns |
|---|---|---|---|
| `GET` | `/v1/projects` |, | `{ projects: [{ id, name, slug, apps }] }` |
| `POST` | `/v1/projects` | `{ name, apps }` | `201 { id, name, slug, apps }` |
| `PATCH` | `/v1/projects/:id` | `{ name?, apps? }` | `200 { id, name, slug, apps }` |
| `DELETE` | `/v1/projects/:id` |, | `204` |

Errors: `400` (bad shape / empty name / dup name / oversize), `401` (no valid
key), `404` (unknown id), `503` (Mongo unavailable). `slug` is generated from
`name` (kebab-case, deduped with a numeric suffix if needed). `apps` are stored
verbatim (free strings, a service may exist before any event from it arrives).

## 6. Server, project-scoped reads

Add an optional **`project`** query param to `/v1/logs`, `/v1/stats`,
`/v1/groupby`, `/v1/facets`, `/v1/events`.

- `project` accepts a project **`_id` or `slug`**; the server resolves it to the
  project's `apps` and applies `{ app: { $in: apps } }`.
- **Empty project** (no member apps) → matches nothing (clean empty state).
- **Unknown project** → `400` (`unknown project`).
- The existing single **`app`** param still works and composes as a
  **drill-down**: with both `project` and `app`, results are `app` *and* `app ∈
  project.apps`, i.e. the one service, only if it's a member (else empty).
- This is the only change to the query files; keyset cursor, TTL, percentiles,
  and `$dateTrunc`/`$facet` aggregations are otherwise untouched.

## 7. Server, Jobs API

New `GET /v1/jobs` (`canRead`), project-scoped. Aggregates events whose `name`
starts with any prefix in `TIMBER_JOBS_EVENT_PREFIX` (default `cron.`) within the
time window + project scope.

Returns one row per job `name`:

```jsonc
{ "jobs": [
  { "name": "cron.nightly-report",
    "lastRunAt": "<ISO>", "lastStatus": "ok" | "failed",
    "runs": 42, "failures": 3, "successRate": 0.93,
    "p50Ms": 1200, "p95Ms": 4800 }
] }
```

- **Status convention:** a run is `failed` if `level === "error"` **or**
  `data.status ∈ {error, failed, failure}`; otherwise `ok`.
- **Duration:** `data.latencyMs` (the same field `slow-ops` uses).
- **Graceful fallback:** if no duration field is present, omit `p50Ms`/`p95Ms`;
  if no status signal exists, infer purely from `level`.
- One aggregation: `$match` (name prefix + `app $in` + time) → `$group` by
  `name` with `$last`/`$max`/counts/`$percentile`. Honors `queryMaxTimeMs`.

## 8. Console changes

1. **ProjectSwitcher** (top bar, beside `AppSwitcher`): "All projects" + one per
   project. Selection is a **URL search param** (`project=<slug>`), so views are
   shareable. Selecting a project (a) narrows `AppSwitcher` to the project's
   member services, (b) threads `project` into every query hook. Selecting a
   project **rescopes the current route in place** (no forced navigation).
2. **Manage Projects** dialog, opened from the switcher and mirroring the
   existing `SettingsDialog` (`web/src/components/SettingsDialog.tsx`): list,
   **create** (name + multi-select services sourced
   from `/v1/events` apps, with free-text add for not-yet-seen services),
   rename, edit members, delete. CRUD via TanStack Query mutations with cache
   invalidation. Editable because `canRead` (the Console's key) is sufficient.
3. **Project Overview dashboard** (`/overview`, a nav tab, the project's
   at-a-glance): one card per lens, **Errors** (count + sparkline),
   **AI usage** (calls/tokens/cost), **By user** (top users), **By service**
   (breakdown across the project's services), **Slow operations** (count over
   `slowMs` + slowest), **Cron & Jobs** (job-health summary). Each card deep-links
   into Explore/Stats/Jobs pre-scoped. Reuses existing hooks
   (`useStats`/`useGroupBy`/`useLogs`) and the existing lens definitions.
4. **Jobs dashboard** (`/jobs`): table from `/v1/jobs`, last run, status badge,
   success rate, p50/p95, runs; click a job → Explore filtered to that `name`.
   The scoped `cron.*` lens remains in the rail (the "both").

Nav gains **Overview** and **Jobs**. When "All projects" is selected, Explore/
Stats behave exactly as today (no project filter).

## 9. Data flow

```
API key ──► event (app/env stamped) ──► Mongo (events)
                                          ▲
projects (Mongo) ── resolve project→apps ─┘ ($in at query time)

Console: ProjectSwitcher → project in URL → hooks pass `project`
       → server resolves to app $in → results.
Jobs:   /v1/jobs aggregation (cron.* + project scope).
```

## 10. Config additions

| Env | Default | Meaning |
|---|---|---|
| `TIMBER_PROJECTS_COLLECTION` | `projects` | Mongo collection for project metadata |
| `TIMBER_JOBS_EVENT_PREFIX` | `cron.` | Comma-separated event-name prefixes treated as jobs |

## 11. Error handling

- CRUD: `400` bad shape / empty or duplicate name / oversize; `404` missing id;
  `503` when Mongo is down. Console surfaces errors via the existing `Banner`.
- Unknown `project` on a read → `400`; empty project → empty results + a clear
  empty state in the UI.
- Deleting the currently-selected project → Console falls back to "All projects".

## 12. Security

- Project metadata (names + service lists) is low-sensitivity; mutations are
  gated by `canRead` per the chosen model, the read key already exposes all
  logs, so it is not the weakest link. Documented in USAGE.md.
- Same-origin proxy model is unchanged; no new CORS surface.
- Input validation mirrors `validate.js` (no unbounded strings/arrays; reject
  unknown keys) to keep the framework-free server hardened.

## 13. Testing

- **Server (`node:test`, real-Mongo + WAL modes):** projects CRUD (validation,
  dup-name, auth, 404), `slug` generation, `project`→`app $in` resolution
  (incl. empty/unknown and `app`+`project` drill-down), `/v1/jobs` aggregation
  (status + duration + percentiles, and the no-field fallbacks).
- **Console (vitest + MSW):** ProjectSwitcher (URL round-trip, narrows
  AppSwitcher), Manage Projects CRUD, Overview cards issue the right scoped
  queries, Jobs table render + drill-in, a11y for the new controls, matching
  current standards.

## 14. Non-goals (YAGNI)

- No per-user/role permissions or project ownership (single shared key model).
- No new event fields, no client/SDK changes, no data migration.
- No project-level retention/TTL overrides (TTL stays per-level as today).
- No cross-project aggregation beyond "All projects" (= no project filter).

## 15. Suggested phasing (for the implementation plan)

1. **Projects core:** collection + CRUD API + `project` param on read endpoints
   + config + tests.
2. **Console scope:** ProjectSwitcher + Manage Projects + thread `project`
   through hooks; lenses become project-scoped for free.
3. **Overview dashboard:** the six-card project landing.
4. **Jobs:** `/v1/jobs` endpoint + Jobs dashboard route.
