# Timber Console — design spec (frontend + supporting query-API additions)

> Status: approved-in-design 2026-06-14 (revised same day to add faceted finding, lenses/views, in-app docs, and two server endpoints).
> A polished internal log console over the existing Timber API (see [PRD.md](../../../PRD.md) §6, server in `src/`). v1 adds two small, additive query endpoints to the server; the ingest/WAL/flusher hot path is NOT touched.

## 1. Goal

A SaaS-quality internal log console for the teams/services/apps shipping to Timber: fast full-text-ish + structured search, faceted finding ("user-wise", "error-wise", "by service"), curated + saved views, a live tail, expandable JSON detail, a stats dashboard (incl. AI cost/tokens), and an in-app API docs/onboarding section. Single-page app, client-side read-key auth, light + dark themes.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Framework | TanStack Router + Vite + React + TypeScript (client SPA — read key is client-side, SSR buys nothing) |
| Scope | Explore (search/tail/detail/facets) + Stats (volume, error rate, AI cost/tokens, latency) + Docs (in-app API guide) |
| Faceting / group-by | **Server-assisted**: add `GET /v1/facets` (discover `ids.*` keys + top-level `data.*` paths) and `GET /v1/groupby` (counts per value over a filter+window). Accurate across the whole dataset; powers "errors by user", value autocomplete. |
| Access model (v1) | Single read key sees all apps (PRD §6.3). Console scopes/pivots by app. Per-key app-scoping is an explicit v2 non-goal. |
| AI cost | Part of the Stats page (no separate page) |
| Built-in UI | New standalone app in `web/`. The zero-dep vanilla UI at `/` stays as a fallback. |
| Themes | Light + dark toggle, persisted to localStorage |
| Server hot path | Unchanged. Only the read/query side gains two endpoints, consistent with the existing query module + fully tested. |

## 3. Non-goals (v1)

- No ingestion/writing from the UI (read-only console).
- No per-key app-scoping / RBAC (single read key; v2).
- No saved-search persistence beyond localStorage + URL (the URL is the shareable saved search).
- Facet discovery covers top-level `ids.*` and `data.*` keys; deeper nested `data.a.b` paths are still queryable/groupable manually but not auto-discovered (v2).
- No alerting (PRD phase 2). No SSR/RSC.

## 4. Stack & dependencies (frontend)

`react`, `react-dom`, `@tanstack/react-router`, `@tanstack/react-query`, `@tanstack/react-virtual`, `recharts`, `lucide-react`; `tailwindcss@^4` + `@tailwindcss/vite`. Dev/test: `vite`, `typescript`, `@vitejs/plugin-react`, `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `msw`; optional `@playwright/test`. Code highlighting in Docs: `shiki` (build-time) or a tiny inline highlighter — no heavy runtime dep. No state lib (react-query + URL state).

## 5. Server additions (in `src/`, additive)

Two read endpoints in the existing query module style (contracts C8–C10). Both: auth = read or write key (401 unknown), 503 when no Mongo collection, 400 on bad params. Both are **time-windowed** (default last 24h, overridable) so scans stay bounded (PRD query target ≤500ms for an hour window).

### 5.1 `GET /v1/facets` — discover available facet fields
- Params: `app?` (scope), `from?`/`to?` (window; ISO or epoch ms).
- Pipeline (windowed `$match` → `$project` with `$objectToArray` over `$ids` and top-level `$data` → `$unwind` → `$group` distinct key names). New file `src/query/facets.js`: `parseFacetsQuery(searchParams)`, `runFacets(collection, value, {maxTimeMS})`.
- Response: `{ window:{from,to}, idsKeys: string[], dataPaths: string[] }` (both sorted asc). Drives the Find-by key picker and the Group-by dimension list.

### 5.2 `GET /v1/groupby` — counts per distinct value of one field
- Params: `by=<field>` REQUIRED ∈ { `app`,`env`,`level`,`event`, `ids.<key>`, `data.<path>` }; field name validated `/^(app|env|level|event|ids\.[\w.-]+|data\.[\w.-]+)$/` (rejects `$`/injection → 400). Plus the SAME scoping filters as `/v1/logs` (`app`,`env`,`level`,`event`,`from`,`to`,`ids.*`,`data.*`,`q`) reusing the logs filter builder — but NOT `cursor`. Plus `limit` (top-N values, default 20, max 100), `like` (optional case-insensitive substring to filter values — powers value autocomplete).
- Pipeline: `[{$match: filter}, {$group:{_id:'$'+by, count:{$sum:1}}}, ...(like ? [{$match:{_id:{$regex:escaped,$options:'i'}}}] : []), {$sort:{count:-1,_id:1}}, {$limit:N}]`, plus a parallel `$count` (via `$facet`) for `total`. New file `src/query/groupby.js`: `parseGroupByQuery`, `buildGroupByPipeline` (exported for unit tests), `runGroupBy`.
- Response: `{ by, window:{from,to}, total, groups: [{ value, count }], otherCount }` (`otherCount = total − Σ shown`).
- Powers: "errors by user" (`by=ids.userEmail&level=error,warn`), "events by service" (`by=app`), "cost drivers" (`by=data.model` + client-side join with stats), value autocomplete (`by=ids.userEmail&like=ali`).

### 5.3 Server wiring + tests
- `src/server.js`: two routes behind `readGate`, passing `{maxTimeMS: config.queryMaxTimeMs}`; import the two parse+run pairs.
- Tests: `test/query-facets.test.js`, `test/query-groupby.test.js` against the fake collection (extend `test/helpers/fake-collection.js` only if a needed operator like `$objectToArray`/`$facet`/`$count`/`$regex`-on-`_id` is missing); `test/server.test.js` rows for the two routes (401/503/400-bad-`by`/200 shape); `test/integration-mongo.test.js` real-Mongo cases for both. `USAGE.md` gains both endpoints.

## 6. Project layout (frontend)

```
web/
  package.json, vite.config.ts (react + tailwind; dev proxy /v1 + /healthz → :7710), tsconfig.json, index.html
  src/
    main.tsx, router.tsx
    routes/
      __root.tsx        # shell: brand, app switcher, nav (Explore/Stats/Docs), health dot, theme, settings
      explore.tsx       # "/"  search + facets rail + virtualized results + detail
      stats.tsx         # "/stats"
      docs.$page.tsx    # "/docs/*" in-app API guide
    lib/ api.ts, types.ts, filters.ts (Filters<->URLSearchParams, mirrors C8), views.ts (lens presets + saved views), time.ts, settings.ts
    hooks/ useLogs.ts, useLiveTail.ts, useStats.ts, useEvents.ts, useFacets.ts, useGroupBy.ts, useHealth.ts
    components/ FilterBar, LevelChips, EventCombobox, TimeRangePicker, AdvancedFilters, FindByBar,
                LensRail (curated + saved views), GroupByPanel (breakdown bars), ResultsTable (virtualized),
                LogRow, DetailPanel (pivot-on-value), AppSwitcher, MetricCards, StatChart, HealthDot,
                SettingsDialog, ThemeToggle, Banner, CodeBlock (copy)
    content/docs/*       # docs page content (overview, quickstart, contract, conventions, sending-logs, query-api, recipes, keys)
    theme/tokens.css
  test/                  # vitest + RTL + msw + fixtures
```

## 7. Filters → query params (mirror of server contract C8)

`filters.ts` maps `Filters` ↔ `URLSearchParams`; all filter state lives in the URL (shareable/bookmarkable, back/forward = filter history).

| UI | Param |
|---|---|
| app (AppSwitcher / select from `/v1/events`) | `app=` |
| env | `env=` |
| levels (chips) | `level=<csv>` |
| event prefix (combobox, suggestions from `/v1/events`) | `event=` |
| free-text | `q=` (regex over `message`, ≤256 chars; UI hints "regex") |
| time range (15m/1h/6h/24h/7d/custom) | `from=` + `to=` (ISO) |
| Find-by / id rows | `ids.<key>=` |
| data path rows `=` | `data.<path>=` |
| data path rows `≥`/`≤` | `data.<path>__gte=` / `__lte=` |
| page size | `limit=` (1..500, default 100) |
| pagination | `cursor=` (managed by `useInfiniteQuery`) |

Server `400 {error}` surfaces inline on the offending control.

## 8. Views & behavior

### 8.1 Shell
Top bar: brand; **AppSwitcher** (all apps from `/v1/events`, "all apps" default); nav Explore / Stats / Docs; health dot (green/red from `/healthz`, tooltip = wal backlog + flusher + mongo); theme toggle; settings. First run (no key) → Settings dialog.

### 8.2 Explore (`/`)
- **LensRail** (left): curated lenses = preset filters + optional group-by, one click to apply (writes the URL):
  - Errors & warnings (`level=warn,error`), AI usage (`event=ai.`), By user (group `ids.<userKey>`), By service (group `app`), Slow operations (`data.latencyMs__gte=300` ∪ `durationMs__gte=300`; threshold default 300 ms, adjustable per-view via a control in the lens), Cron & jobs (`event=cron.`).
  - Saved views: user-named filter snapshots in localStorage; "Save current view"; each is a shareable URL.
- **FilterBar** (top): all §7 controls. **FindByBar**: pick an id key (from `/v1/facets`, default `userEmail`) + type a value (autocomplete via `/v1/groupby?by=ids.<key>&like=`) → adds `ids.<key>=`.
- **GroupByPanel** (toggle): choose a dimension (app/level/event or any discovered `ids.*`/`data.*`) → horizontal count bars from `/v1/groupby` over the current filter+range (e.g. "errors by user"); click a bar → adds that value as a filter and drills in. Shows `otherCount`.
- **ResultsTable**: virtualized (`@tanstack/react-virtual`); Time (relative, absolute on hover) · Level chip · App · Event (mono) · Message. Infinite scroll via `useInfiniteQuery` (`getNextPageParam = last.nextCursor`).
- **LogRow → DetailPanel**: full pretty JSON; **pivot-on-value**: clicking any `ids.*`/`data.*` leaf adds the matching filter ("show all logs where `userEmail=x`"); copy-JSON; copy deep link.
- **Live tail**: when on, `useLiveTail` refetches page 1 every `tailIntervalMs` (default 2000) **only when `document.visibilityState==='visible'`**, prepends new `_id`s (highlight), dedupes by `_id`, auto-pauses when scrolled off the top.

### 8.3 Stats (`/stats`)
Range/app-linked to Explore. From `/v1/stats`: metric cards (total events, error rate %, AI cost Σ, p95 latency, total tokens); recharts — volume per bucket stacked by level, error-rate % line, AI cost over time + running total, tokens over time, latency p50/p95/p99 lines. `latency:null`/`errorRate:null` → gaps, not zero. Group hour/day toggle. A small "top by" strip reuses `/v1/groupby` (top services, top users, top models).

### 8.4 Docs (`/docs/*`)
In-app onboarding, content in `content/docs/`, left nav, copy-able code blocks, deep links into the Console for recipes. Pages:
1. Overview (what/why, WAL→Mongo architecture + guarantees) · 2. Quickstart (get a key → send first log → view it) · 3. Event contract (envelope, levels, ids, data, size rules, redaction, IDs-not-payloads) · 4. Conventions (latencyMs/durationMs, status, costUsd, tokens — what each powers) · 5. Sending logs (curl; Node tap + `ai.request` wrapper; Python `logging.Handler`; batching/backoff/never-throw — from PRD §8) · 6. Query API reference (`/v1/logs` all filters + examples, cursor pagination, `/v1/stats`, `/v1/events`, `/v1/facets`, `/v1/groupby`, `/healthz`; auth; status codes) · 7. Recipes ("all logs for a user", "errors last hour for service X", "AI cost today by model", "slow queries", cursor walk) — each with curl + a one-click Console link · 8. Keys & access (read vs write, rotation, sharing the read key with an AI assistant).
Content is authored to match PRD + USAGE.md so it stays authoritative; a test asserts documented endpoints/params match the real API surface.

### 8.5 Settings
Read key (password), API base URL (default same-origin), theme, tail interval, and **user identity keys** (ordered list, default `["userEmail","userId"]`) used as the default for "By user"/FindBy. Persisted to localStorage; "Test connection" pings `/healthz` + `limit=1` logs query.

## 9. Data flow, states, errors
Typed `api.ts` (base URL + `Bearer`). Query keys: `['logs',filters]` (infinite), `['stats',range]`, `['events']`, `['facets',app,range]`, `['groupby',by,filters]`, `['health']`. Loading → skeletons. Empty → "no events match" + clear-filters. `401` → Banner → Settings (queries paused). `503` → "storage unavailable" + backoff. Offline → retry w/ backoff.

## 10. Theming
`theme/tokens.css`: CSS variables for both modes (approved palette) — indigo accent (`#4F46E5`/`#838CF7`), neutral slate surfaces, level colors debug=slate/info=blue/warn=amber/error=red as chip text over tints. `data-theme` on `<html>`, default system, persisted. One file to reskin.

## 11. Dev & prod serving (no CORS)
Dev: Vite proxies `/v1` + `/healthz` → `http://localhost:7710`; app uses relative URLs. Prod: `vite build` → `web/dist`, served same-origin behind the existing nginx (which proxies the API). `apiBaseUrl` settable for split-origin (operator adds proxy; server adds no CORS). Built-in `/` UI untouched.

## 12. Testing
- Server: `test/query-facets.test.js`, `test/query-groupby.test.js` (parse + `buildGroupByPipeline` exact shape + run over fake collection incl. `by=ids.userEmail`, `like`, `otherCount`, bad-`by` 400); `server.test.js` route rows; real-Mongo integration rows.
- Frontend (vitest + RTL + msw, fixtures from PRD §5.2 examples incl. `ids.userEmail`): filter↔URL round-trips (every §7 row); infinite-scroll cursor walk (3 pages, no dup/gap); live-tail prepend+dedupe+visibility gating; lens apply + saved-view round-trip; FindBy autocomplete (mocked groupby); GroupByPanel bars + drill-in; pivot-on-value; Stats incl. null gaps; Docs render + "documented API matches real surface" assertion; 401/503/empty banners; theme + settings persistence.
- Optional Playwright e2e against a seeded real server. Lint/typecheck: `tsc --noEmit`, `vitest run`, `vite build`.

## 13. Acceptance
- Server: facets/groupby pass unit + real-Mongo tests; full suite green; documented in USAGE.md.
- Frontend: all §12 tests pass; `tsc` clean; `vite build` succeeds.
- Manual (seeded real server): search by app/level/event/`data.<path>`; **find all logs for a user** via FindBy and via pivot-on-value; **"errors by user"** breakdown via GroupByPanel; lenses + saved views; cursor load-more; live tail; Stats charts incl. cost/tokens; Docs pages render with working recipe links; 401/503 handled; theme persists.
