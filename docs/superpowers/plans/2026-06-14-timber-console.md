# Timber Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
>
> **Execution model:** like the server build — frozen contracts + file-ownership table → parallel TDD agents per phase → controller commits between phases. Build agents do NOT `git commit`. Each task is TDD: write the failing test from the contract, watch it fail, implement to green. Branch: `feat/timber-console`.

**Goal:** Build the Timber Console per [the spec](../specs/2026-06-14-timber-console-frontend-design.md): a TanStack-Router + Vite SPA for searching/viewing logs (faceted finding, lenses/saved views, live tail, stats, in-app API docs), plus two additive server query endpoints (`/v1/facets`, `/v1/groupby`).

**Architecture:** Client SPA in `web/` consuming the existing Timber query API (read key in localStorage, same-origin via Vite proxy in dev / nginx in prod — no CORS). TanStack Query for caching/infinite-scroll/polling; URL holds all filter state. Server gains two small read endpoints in the existing query-module style; ingest/WAL/flusher untouched.

**Tech Stack:** React 18 + TypeScript, `@tanstack/react-router`, `@tanstack/react-query`, `@tanstack/react-virtual`, `recharts`, `lucide-react`, `tailwindcss@4`; Vite; Vitest + Testing Library + MSW. Server side: Node 22 ESM, `mongodb` (already present), `node:test`.

---

## Conventions

- **Frontend tests:** Vitest + `@testing-library/react` + `@testing-library/user-event`; network mocked with MSW. jsdom environment. Each test file passes standalone (`npx vitest run src/x.test.tsx`) and via `npm test` in `web/`.
- **Server tests:** `node:test` + `node:assert/strict` at repo root (existing harness), run via root `npm test`.
- **No `any`** in committed TS except where interfacing untyped JSON (`data: unknown`, narrowed at use). `tsc --noEmit` must pass.
- **Styling:** Tailwind v4 utility classes + CSS variables from `theme/tokens.css`. No inline color hexes in components — use the token classes/vars so theming works.
- **Imports:** path alias `@/` → `web/src/`.
- Build agents work only on files their task owns; importing other contract modules is fine, editing them is not.

---

## Shared contracts — frozen. Code to these.

### Server side (additive, in `src/`)

#### C-S1. `GET /v1/facets` — `src/query/facets.js`
```js
export function parseFacetsQuery(searchParams) -> {ok:true, value:{from:Date,to:Date,app?}} | {ok:false,error}
// params: app? (exact); from?/to? (ISO or epoch-ms digits; default to=now, from=to-24h); unknown param -> 400
export async function runFacets(collection, value, {maxTimeMS} = {}) ->
  {window:{from:ISO,to:ISO}, idsKeys:string[], dataPaths:string[]}
// pipeline (windowed): $match {receivedAt:{$gte:from,$lt:to}, ...(app&&{app})} ->
//   $project {ik:{$map:{input:{$objectToArray:{$ifNull:['$ids',{}]}},as:'k',in:'$$k.k'}},
//             dk:{$map:{input:{$objectToArray:{$ifNull:['$data',{}]}},as:'k',in:'$$k.k'}}} ->
//   $facet { ids:[{$unwind:'$ik'},{$group:{_id:'$ik'}}], data:[{$unwind:'$dk'},{$group:{_id:'$dk'}}] }
// post: idsKeys = ids[]._id sorted asc; dataPaths = data[]._id sorted asc. maxTimeMS applied when >0.
```

#### C-S2. `GET /v1/groupby` — `src/query/groupby.js`
```js
const BY_RE = /^(app|env|level|event|ids\.[\w.-]+|data\.[\w.-]+)$/; // rejects '$'/injection
export function parseGroupByQuery(searchParams) ->
  {ok:true, value:{by, filter, limit, like?}} | {ok:false,error}
// by= REQUIRED, must match BY_RE else 400 'invalid by field'.
// filter = REUSE src/query/logs.js parseLogsQuery semantics for app,env,level,event,from,to,ids.*,data.*,q
//   (NO cursor). Implement by importing a shared filter builder; if parseLogsQuery is monolithic,
//   factor out `buildLogsFilter(searchParams)` in logs.js (its only out-of-file change) and reuse it
//   in BOTH logs and groupby. limit: int 1..100 default 20. like: optional string (<=128 chars).
export function buildGroupByPipeline({by, filter, limit, like}) -> pipeline   // exported for unit tests
// [{$match: filter},
//  {$group:{_id:'$'+by, count:{$sum:1}}},
//  ...(like ? [{$match:{_id:{$regex: escapeRegex(like), $options:'i'}}}] : []),
//  {$facet:{ groups:[{$sort:{count:-1,_id:1}},{$limit:limit}], totals:[{$group:{_id:null,total:{$sum:'$count'}}}] }}]
export async function runGroupBy(collection, value, {maxTimeMS} = {}) ->
  {by, total:number, groups:[{value:any,count:number}], otherCount:number}
// total from totals[0].total||0; groups map _id->value; otherCount = total - sum(groups.count) (floor 0).
```

#### C-S3. Server wiring — `src/server.js` (+ docs)
Two routes behind `readGate`, mirroring `/v1/stats`:
```js
router.add('GET','/v1/facets', async (req,res,url)=>{ const c=readGate(req,res); if(!c)return;
  const p=parseFacetsQuery(url.searchParams); if(!p.ok) return sendError(res,400,p.error);
  sendJson(res,200, await runFacets(c,p.value,{maxTimeMS:config.queryMaxTimeMs})); });
router.add('GET','/v1/groupby', async (req,res,url)=>{ const c=readGate(req,res); if(!c)return;
  const p=parseGroupByQuery(url.searchParams); if(!p.ok) return sendError(res,400,p.error);
  sendJson(res,200, await runGroupBy(c,p.value,{maxTimeMS:config.queryMaxTimeMs})); });
```
Imports added to server.js. `USAGE.md` gains both endpoints with curl examples.

### Frontend (in `web/src/`)

#### C-F1. `lib/types.ts`
```ts
export type Level = 'debug'|'info'|'warn'|'error';
export interface LogDoc { _id:string; app:string; env:string; event:string; level:Level;
  ts?:string; message?:string; ids?:Record<string,string>; data?:unknown;
  receivedAt:string; expiresAt:string; }
export interface LogsResponse { items:LogDoc[]; nextCursor:string|null }
export interface StatsBucket { bucket:string; total:number; counts:Record<Level,number>;
  latency:{p50:number;p95:number;p99:number}|null; errorRate:number|null;
  costUsd:number; inputTokens:number; outputTokens:number }
export interface StatsResponse { group:'hour'|'day'; from:string; to:string; buckets:StatsBucket[] }
export interface EventsResponse { apps:Record<string,string[]> }
export interface FacetsResponse { window:{from:string;to:string}; idsKeys:string[]; dataPaths:string[] }
export interface GroupByResponse { by:string; total:number; groups:{value:string|number|boolean|null;count:number}[]; otherCount:number }
export interface Health { ok:boolean; wal:{totalBytes:number;backlogBytes:number;overBudget:boolean};
  flusher:{running:boolean;caughtUp:boolean;flushedTotal:number;lastError:string|null}; mongo:{connected:boolean} }
export class ApiError extends Error { constructor(public status:number, public body:any){ super(`HTTP ${status}`);} }
```

#### C-F2. `lib/api.ts`
```ts
// Reads base URL + key from settings (C-F5). All calls send Authorization: Bearer <key> when key present.
export function apiGet<T>(path:string, params?:URLSearchParams): Promise<T>
//   GET (baseUrl||'') + path + (params?`?${params}`); on !res.ok throw new ApiError(status, jsonOrText);
//   401/503 carry through as ApiError for the UI to branch on.
export const getLogs   = (p:URLSearchParams)=>apiGet<LogsResponse>('/v1/logs', p);
export const getStats  = (p:URLSearchParams)=>apiGet<StatsResponse>('/v1/stats', p);
export const getEvents = (p?:URLSearchParams)=>apiGet<EventsResponse>('/v1/events', p);
export const getFacets = (p:URLSearchParams)=>apiGet<FacetsResponse>('/v1/facets', p);
export const getGroupBy= (p:URLSearchParams)=>apiGet<GroupByResponse>('/v1/groupby', p);
export const getHealth = ()=>apiGet<Health>('/healthz');   // no auth required but header harmless
```

#### C-F3. `lib/filters.ts` — the search contract (mirror server C8)
```ts
export interface IdFilter { key:string; value:string }              // ids.<key>=value
export interface DataFilter { path:string; op:'eq'|'gte'|'lte'; value:string }
export interface Filters { app?:string; env?:string; levels:Level[]; event?:string; q?:string;
  from?:string; to?:string; ids:IdFilter[]; data:DataFilter[]; limit?:number }
export function filtersToParams(f:Filters): URLSearchParams
//   levels -> level=csv (omit if empty OR all 4); event/q/app/env/from/to as-is when set;
//   ids[] -> ids.<key>=value; data eq -> data.<path>=value; gte -> data.<path>__gte=value; lte -> __lte;
//   limit when set. Never emits cursor (infinite-query adds it).
export function paramsToFilters(p:URLSearchParams): Filters    // inverse; tolerant of missing keys
export const ALL_LEVELS:Level[] = ['debug','info','warn','error'];
```
Round-trip property: `paramsToFilters(filtersToParams(f))` preserves all fields (levels order-insensitive).

#### C-F4. `lib/views.ts` — lenses + saved views
```ts
export interface Lens { id:string; label:string; icon:string; apply:(base:Filters,cfg:ViewCfg)=>Filters; groupBy?:string }
export interface ViewCfg { userKeys:string[]; slowMs:number }    // from settings
export const BUILTIN_LENSES:Lens[];   // errors, ai-usage, by-user(groupBy ids.<userKeys[0]>), by-service(groupBy 'app'),
//   slow-ops (data.latencyMs__gte=slowMs AND a second view OR'd with durationMs — implement as latency>=slowMs;
//   note: server has no OR across two data paths, so slow-ops sets data.latencyMs__gte=slowMs and the lens
//   also offers a toggle for durationMs; default uses latencyMs), cron (event='cron.')
export interface SavedView { id:string; name:string; params:string /* serialized URLSearchParams */ }
export function loadSavedViews():SavedView[]; export function saveView(v:SavedView):void; export function deleteView(id:string):void;
//   localStorage key 'timber.savedViews'
```

#### C-F5. `lib/settings.ts`
```ts
export interface Settings { apiBaseUrl:string; readKey:string; theme:'system'|'light'|'dark';
  tailIntervalMs:number; userKeys:string[]; slowMs:number }
export const DEFAULTS:Settings = { apiBaseUrl:'', readKey:'', theme:'system',
  tailIntervalMs:2000, userKeys:['userEmail','userId'], slowMs:300 };
export function loadSettings():Settings;  export function saveSettings(s:Partial<Settings>):Settings;
// localStorage key 'timber.settings'; merge over DEFAULTS. Emits a 'timber:settings' event on save.
```

#### C-F6. `lib/time.ts`
```ts
export interface RangePreset { id:string; label:string; ms:number }   // 15m,1h,6h,24h,7d
export const PRESETS:RangePreset[];
export function presetRange(id:string, now:Date):{from:string;to:string}; // ISO
export function fmtRelative(iso:string, now:Date):string;  // "12s ago","3m ago"
export function fmtAbsolute(iso:string):string;            // local "2026-06-14 10:42:09"
```

#### C-F7. Theme — `theme/tokens.css` + `lib/theme.ts`
`tokens.css`: `:root` (light) + `:root[data-theme=dark]` (dark) defining `--tb-bg,--tb-surface,--tb-2,--tb-border,--tb-text,--tb-mut,--tb-acc,--tb-debug,--tb-info,--tb-warn,--tb-error` exactly the approved palette (light: accent `#4F46E5`, bg `#F6F8FB`, surface `#FFFFFF`, border `#E2E7EE`, text `#1A1E27`, mut `#5C6573`, debug `#6B7280`, info `#2563EB`, warn `#B7791F`, error `#DC2626`; dark: accent `#838CF7`, bg `#0B0C10`, surface `#131620`, 2 `#1A1F2C`, border `#262C3B`, text `#E7E9EE`, mut `#8B93A6`, debug `#7E889B`, info `#5B95F7`, warn `#E6A23C`, error `#F06A78`). `lib/theme.ts`: `applyTheme(t)` sets `document.documentElement.dataset.theme` (resolving 'system' via `matchMedia`), persists via settings.

#### C-F8. Hooks (in `hooks/`, all consume C-F2 + react-query)
```ts
useLogs(filters:Filters)      // useInfiniteQuery; queryFn pageParam=cursor; getNextPageParam=last.nextCursor; returns flat items + fetchNextPage + hasNextPage
useLiveTail(filters,enabled)  // useQuery page-1 (no cursor) refetchInterval=settings.tailIntervalMs, enabled && document.visibilityState; returns new items to prepend (dedupe by _id handled in Explore)
useStats(range,group,app?,event?)   useEvents()   useHealth()  // refetchInterval 10s
useFacets(app?,range)         useGroupBy(by,filters,{limit,like,enabled})
```
All disabled when `settings.readKey===''`. 401/503 surfaced via query error (ApiError) for Banner.

#### C-F9. Component prop contracts (presentational — internals to props + tests)
```ts
FilterBar({filters,onChange}) ; LevelChips({value:Level[],onChange}) ;
EventCombobox({app,value,onChange}) /* suggests from useEvents */ ;
TimeRangePicker({from,to,onChange}) ; AdvancedFilters({ids,data,onChange}) ;
FindByBar({onAdd}) /* key picker from useFacets + value autocomplete from useGroupBy(like) */ ;
LensRail({active,onApplyLens,savedViews,onApplySaved,onSaveCurrent,onDeleteSaved}) ;
GroupByPanel({by,filters,onPick}) /* bars from useGroupBy; onPick(value) adds filter */ ;
ResultsTable({items,onRowClick,selectedId,onLoadMore,hasMore,loading}) /* virtualized */ ;
LogRow({doc,selected,onClick}) ; DetailPanel({doc,onPivot}) /* onPivot(filterFragment) */ ;
AppSwitcher({apps,value,onChange}) ; MetricCards({stats}) ; StatChart({buckets,kind}) ;
HealthDot({health}) ; SettingsDialog({open,onClose}) ; ThemeToggle() ;
Banner({kind:'401'|'503'|'offline',onAction?}) ; CodeBlock({code,lang}) /* copy button */ ;
```

#### C-F10. Routing & URL (`router.tsx`, `routes/`)
TanStack Router, routes: `/` (explore), `/stats`, `/docs/$page` (default page 'overview'). Explore + Stats read filter state from `validateSearch` parsing the same params as C-F3 (the URL is the single source of truth). Navigations update search params (replace for filter edits, push for lens/nav).

---

## File ownership

| Task | Files |
|---|---|
| S1 facets | `src/query/facets.js`, `test/query-facets.test.js` |
| S2 groupby | `src/query/groupby.js`, `test/query-groupby.test.js`; may factor `buildLogsFilter` in `src/query/logs.js` |
| S3 server-wire | `src/server.js`, `test/server.test.js`, `test/integration-mongo.test.js`, `USAGE.md`; extend `test/helpers/fake-collection.js` if needed |
| F0 scaffold | `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/index.html`, `web/src/main.tsx`, `web/src/router.tsx`, `web/src/vite-env.d.ts`, `web/.gitignore`, `web/tailwind` setup, `web/src/styles.css` |
| F1 types+api | `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/lib/api.test.ts` |
| F2 filters | `web/src/lib/filters.ts`, `web/src/lib/filters.test.ts` |
| F3 lib-misc | `web/src/lib/time.ts`, `web/src/lib/settings.ts`, `web/src/lib/views.ts`, `web/src/lib/theme.ts` + `*.test.ts` |
| F4 tokens+shell | `web/src/theme/tokens.css`, `web/src/components/ThemeToggle.tsx`, `web/src/components/HealthDot.tsx`, `web/src/components/Banner.tsx`, `web/src/routes/__root.tsx` |
| F5 hooks | `web/src/hooks/*.ts` + `web/src/hooks/*.test.tsx` |
| F6 filter-cmps | `web/src/components/{FilterBar,LevelChips,EventCombobox,TimeRangePicker,AdvancedFilters,AppSwitcher}.tsx` + tests |
| F7 results | `web/src/components/{ResultsTable,LogRow,DetailPanel}.tsx` + tests |
| F8 facet-cmps | `web/src/components/{FindByBar,LensRail,GroupByPanel}.tsx` + tests |
| F9 stats-cmps | `web/src/components/{MetricCards,StatChart}.tsx` + tests |
| F10 explore | `web/src/routes/explore.tsx` + test |
| F11 stats-route | `web/src/routes/stats.tsx` + test |
| F12 docs | `web/src/routes/docs.$page.tsx`, `web/src/content/docs/*.tsx|md`, `web/src/components/{CodeBlock,SettingsDialog}.tsx` + tests (incl. "docs match API surface") |
| F13 integrate | `web/src/App` wiring, msw test harness `web/test/*`, e2e, `web/README.md`; root `README.md` link |

Scaffold prerequisite (controller, before F-phase dispatch): create `web/` via Vite, install deps, commit.

---

## Phase S — server endpoints

### Task S1: `/v1/facets`
**Files:** Create `src/query/facets.js`; Test `test/query-facets.test.js`.
- [ ] **Step 1 — failing test** (`test/query-facets.test.js`): seed fake collection with docs having varied `ids` (`requestId`,`userEmail`) and `data` (`latencyMs`,`model`,`status`) across a time window; assert `runFacets` returns `idsKeys:['requestId','userEmail']` and `dataPaths:['latencyMs','model','status']` sorted, and `window` ISO strings; assert `parseFacetsQuery` defaults to a 24h window, accepts `app`/`from`/`to`, rejects unknown param with 400.
- [ ] **Step 2 — run, see fail** `node --test test/query-facets.test.js` → module not found.
- [ ] **Step 3 — implement** `src/query/facets.js` per C-S1 (`$objectToArray`/`$facet` pipeline; reuse `escapeRegex`/date parsing patterns from `src/query/stats.js`).
- [ ] **Step 4 — green** `node --test test/query-facets.test.js`.
- (If fake-collection lacks `$objectToArray` or `$facet`, that is added in Task S3's fake-collection extension; S1 test may use a tailored stub for the pipeline-shape assertion and a real-Mongo case is added in S3.)

### Task S2: `/v1/groupby`
**Files:** Create `src/query/groupby.js`; Test `test/query-groupby.test.js`; may factor `buildLogsFilter` out of `src/query/logs.js`.
- [ ] **Step 1 — failing test**: `parseGroupByQuery` requires `by`, rejects `by=data.$where`/`by=foo` (400), accepts `by=app|level|ids.userEmail|data.model`, parses `limit`(default 20, clamp 1..100) + `like`; reuses logs filters (assert e.g. `level=error` scopes). `buildGroupByPipeline` deepEqual the C-S2 shape (with/without `like`). `runGroupBy` over fake collection: `by=ids.userEmail&level=error` → counts per user desc, `total`, `otherCount` when `limit` < distinct; `like=al` filters values.
- [ ] **Step 2 — run, see fail.**
- [ ] **Step 3 — implement** per C-S2; if `parseLogsQuery` can't be reused directly, factor `export function buildLogsFilter(searchParams)` in `logs.js` and call it from both (document this as the only logs.js change).
- [ ] **Step 4 — green** `node --test test/query-groupby.test.js`.

### Task S3: wire routes + fake-collection + docs + integration
**Files:** `src/server.js`; `test/server.test.js`; `test/helpers/fake-collection.js` (extend if needed); `test/integration-mongo.test.js`; `USAGE.md`.
- [ ] **Step 1 — failing tests** in `server.test.js`: `GET /v1/facets` and `GET /v1/groupby` → 401 (no key), 503 (no collection), 400 (`groupby` missing/invalid `by`), 200 with the C-S1/C-S2 shapes (seeded fake collection). Extend `fake-collection.js` `aggregate` to support `$objectToArray`, `$facet`, `$count`, and `$regex` on `_id` if those tests need them (add matching cases to `test/fake-collection.test.js`).
- [ ] **Step 2 — run, see fail.**
- [ ] **Step 3 — implement** the two routes in `server.js` (C-S3) + imports; extend fake-collection as required.
- [ ] **Step 4 — integration**: add real-Mongo cases to `test/integration-mongo.test.js` (facets discovers seeded keys; groupby by `ids.userEmail` with `level=error` counts correctly; `like` filter). Add both endpoints to `USAGE.md` with curl examples + response shapes.
- [ ] **Step 5 — green** root `npm test` (standalone) and with `TIMBER_TEST_MONGODB_URI` set.

---

## Phase F0 — scaffold (controller, single task, before parallel F-phase)

### Task F0: create `web/`
**Files:** per ownership row F0.
- [ ] Scaffold: `npm create vite@latest web -- --template react-ts` (run by controller), then add deps: `@tanstack/react-router @tanstack/react-query @tanstack/react-virtual recharts lucide-react`; dev `tailwindcss@4 @tailwindcss/vite vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom msw @types/node`.
- [ ] `vite.config.ts`: react + `@tailwindcss/vite` plugins; `resolve.alias['@']='/src'`; `server.proxy` for `/v1` and `/healthz` → `http://localhost:7710`; `test` config (environment jsdom, setupFiles `./test/setup.ts`, globals).
- [ ] `web/package.json` scripts: `dev`,`build`(`tsc -b && vite build`),`preview`,`test`(`vitest run`),`test:watch`,`typecheck`(`tsc --noEmit`),`lint`.
- [ ] `index.html`, `src/main.tsx` (QueryClientProvider + RouterProvider), `src/router.tsx` (empty route tree with `/`,`/stats`,`/docs/$page`), `src/styles.css` (`@import "tailwindcss"; @import "./theme/tokens.css";`), `test/setup.ts` (jest-dom + MSW server start/stop), `web/.gitignore` (node_modules, dist), `web/README.md` stub.
- [ ] Verify: `cd web && npm run typecheck` clean and `npm run build` succeeds with a placeholder route. (Controller commits F0.)

---

## Phase F-lib — pure modules (parallel; depend only on F0)

### Task F1: types + api client
**Files:** `web/src/lib/types.ts`, `web/src/lib/api.ts`, `web/src/lib/api.test.ts`.
- [ ] **Step 1 — failing test** (MSW): `getLogs` sends `Authorization: Bearer <key>` from settings and returns parsed `LogsResponse`; a 401 response makes `apiGet` throw `ApiError` with `status===401`; `apiBaseUrl` prefixes the path; missing key → still issues request (server decides) but UI gates separately.
- [ ] **Step 2 — fail; Step 3 — implement** C-F1 + C-F2; **Step 4 — green** `npx vitest run src/lib/api.test.ts`.

### Task F2: filters
**Files:** `web/src/lib/filters.ts`, `web/src/lib/filters.test.ts`.
- [ ] **Step 1 — failing test**: every row of C-F3 table (`levels` csv incl. omit-when-all/empty; `ids[]`→`ids.<key>=`; data eq/gte/lte; q; from/to; limit) and the round-trip property `paramsToFilters(filtersToParams(f))≈f`.
- [ ] **Steps 2–4** implement + green.

### Task F3: time + settings + views + theme
**Files:** `web/src/lib/{time,settings,views,theme}.ts` + matching `*.test.ts`.
- [ ] **Step 1 — failing tests**: `presetRange('1h', now)` math; `fmtRelative`/`fmtAbsolute`; settings load/save merge over `DEFAULTS` + persistence (mock localStorage); `BUILTIN_LENSES` produce expected `Filters`/`groupBy` (errors→levels[warn,error]; by-user→groupBy `ids.userEmail`; slow-ops→`data.latencyMs__gte=slowMs`); savedViews CRUD; `applyTheme('dark')` sets `data-theme`.
- [ ] **Steps 2–4** implement C-F4/5/6/7 + green. (`tokens.css` is owned by F4 but `theme.ts` only sets the attribute.)

---

## Phase F-ui1 — shell + hooks (parallel; depend on F-lib)

### Task F4: tokens + shell + status components
**Files:** `web/src/theme/tokens.css`, `components/{ThemeToggle,HealthDot,Banner}.tsx`, `routes/__root.tsx` + tests.
- [ ] **Step 1 — failing tests**: `ThemeToggle` flips `data-theme` + persists (settings); `HealthDot` renders green when `health.ok && mongo.connected`, red otherwise, tooltip text includes backlog/flusher state; `Banner` renders correct copy + action for `401|503|offline`; `__root` renders brand, nav links (Explore/Stats/Docs), and mounts AppSwitcher slot + Settings trigger.
- [ ] **Steps 2–4** implement (`tokens.css` exact palette per C-F7) + green.

### Task F5: data hooks
**Files:** `web/src/hooks/*.ts` + `*.test.tsx`.
- [ ] **Step 1 — failing tests** (MSW + react-query test wrapper): `useLogs` infinite query merges pages and stops at `nextCursor===null`; `useLiveTail` polls only when `enabled` and visibility visible (mock `document.visibilityState`); `useStats`/`useEvents`/`useFacets`/`useGroupBy` return parsed data and pass the right params; all hooks `enabled:false` when `readKey===''`; an `ApiError(401)` surfaces as query error.
- [ ] **Steps 2–4** implement C-F8 + green.

---

## Phase F-ui2 — components (parallel; depend on hooks + lib)

### Task F6: filter components
**Files:** `components/{FilterBar,LevelChips,EventCombobox,TimeRangePicker,AdvancedFilters,AppSwitcher}.tsx` + tests.
- [ ] **Step 1 — failing tests** per C-F9: `LevelChips` toggles; `EventCombobox` suggests from mocked `useEvents` and emits prefix; `TimeRangePicker` emits preset + custom from/to; `AdvancedFilters` add/edit/remove id + data(op) rows; `AppSwitcher` lists apps + "all"; `FilterBar` composes them and calls `onChange` with a correct `Filters`.
- [ ] **Steps 2–4** implement + green. Use tokens for all colors.

### Task F7: results + detail
**Files:** `components/{ResultsTable,LogRow,DetailPanel}.tsx` + tests.
- [ ] **Step 1 — failing tests**: `ResultsTable` renders rows virtualized, calls `onLoadMore` when the sentinel is reached and `hasMore`, marks `selectedId`; `LogRow` shows level chip color class + relative time + truncated message; `DetailPanel` pretty-prints JSON and calls `onPivot` with `{kind:'ids'|'data', key/path, value}` when a leaf is clicked; copy buttons present.
- [ ] **Steps 2–4** implement + green. (Virtualization via `@tanstack/react-virtual`; test with a small list + mocked scroll/IntersectionObserver.)

### Task F8: facet components
**Files:** `components/{FindByBar,LensRail,GroupByPanel}.tsx` + tests.
- [ ] **Step 1 — failing tests**: `FindByBar` populates key options from mocked `useFacets`, autocompletes values via mocked `useGroupBy(like)`, emits an `ids.<key>=value` add; `LensRail` lists `BUILTIN_LENSES` + saved views, applies a lens (calls `onApplyLens`), saves/deletes a view; `GroupByPanel` renders count bars from mocked `useGroupBy`, shows `otherCount`, calls `onPick(value)` on bar click.
- [ ] **Steps 2–4** implement + green.

### Task F9: stats components
**Files:** `components/{MetricCards,StatChart}.tsx` + tests.
- [ ] **Step 1 — failing tests**: `MetricCards` computes total events, error rate %, Σ costUsd, p95 (representative), Σ tokens from a `StatsResponse` (round display values); `StatChart` renders the requested `kind` (`volume|errorRate|cost|tokens|latency`) and treats `null` latency/errorRate buckets as gaps. (Recharts rendered in jsdom: assert data wiring via props/roles, not pixels.)
- [ ] **Steps 2–4** implement + green.

---

## Phase F-routes — assembly (parallel where disjoint; depend on components)

### Task F10: Explore route
**Files:** `web/src/routes/explore.tsx` + test.
- [ ] **Step 1 — failing test** (MSW, full render): URL search params hydrate `FilterBar`; editing a filter updates the URL and refetches; lens click applies preset; FindBy + pivot add filters; GroupByPanel drill-in adds a filter; live-tail toggle prepends + dedupes by `_id`; "load more" appends a page; 401 shows Banner.
- [ ] **Steps 2–4** implement (wire components + hooks + URL state per C-F10) + green.

### Task F11: Stats route
**Files:** `web/src/routes/stats.tsx` + test.
- [ ] **Step 1 — failing test**: renders MetricCards + each StatChart from mocked `/v1/stats`; group hour/day toggle changes the param; range/app shared with Explore via URL; a "top by" strip uses mocked `/v1/groupby`.
- [ ] **Steps 2–4** implement + green.

### Task F12: Docs
**Files:** `web/src/routes/docs.$page.tsx`, `web/src/content/docs/*`, `components/{CodeBlock,SettingsDialog}.tsx` + tests.
- [ ] **Step 1 — failing tests**: docs index lists the 8 pages; each page renders with `CodeBlock` (copy works); recipe links build correct Console URLs (e.g. "all logs for a user" → `/?ids.userEmail=...`); `SettingsDialog` edits key/baseUrl/theme/tail/userKeys/slowMs and persists; **"docs match API" test**: the set of endpoints/params documented equals a fixture derived from the real API surface (`/v1/logs`,`/v1/stats`,`/v1/events`,`/v1/facets`,`/v1/groupby`,`/healthz` and their params) — fails if an endpoint is added without doc.
- [ ] **Steps 2–4** author the 8 pages from PRD + USAGE.md content (Overview, Quickstart, Event contract, Conventions, Sending logs [curl/Node/Python], Query API reference, Recipes, Keys & access) + implement components + green.

### Task F13: integration + e2e + docs polish
**Files:** `web/test/*` (MSW handlers + fixtures), optional Playwright spec, `web/README.md`, root `README.md` link.
- [ ] Build the MSW handler set + PRD-§5.2-style fixtures (ai.request, db.query, cron.run, incl. `ids.userEmail`) shared by route tests.
- [ ] Optional Playwright e2e against `vite preview` + MSW (or seeded real server): load → search → pivot to a user → "errors by user" breakdown → tail → stats → open a docs recipe link.
- [ ] `web/README.md` (dev: `npm run dev` with the server on :7710; build/preview; test) + add a "Console" section to the root `README.md`.
- [ ] **Green:** `cd web && npm run typecheck && npm run test && npm run build`.

---

## Verification (controller, after all phases)

- [ ] Root `npm test` green (server incl. new endpoints), and with `TIMBER_TEST_MONGODB_URI` set (real-Mongo facets/groupby).
- [ ] `cd web && npm run typecheck` clean; `npm run test` green; `npm run build` succeeds.
- [ ] Manual smoke (seeded real Mongo + `node src/server.js`, `cd web && npm run dev`): paste read key; search by app/level/event/`data.<path>`; **find all logs for a user** via FindBy and via pivot-on-value; **"errors by user"** via GroupByPanel; apply lenses + save a view (shareable URL); cursor load-more; live tail; Stats charts incl. AI cost/tokens; Docs pages render with working recipe links; toggle theme (persists); 401 (bad key) and 503 (stop Mongo) banners.
- [ ] Adversarial review workflow (spec compliance / API-contract correctness / a11y + UX / security [key handling, XSS via log content] / quality) → confirmed findings fixed, suites re-green.

## Acceptance (from spec §13)
- Server facets/groupby: unit + real-Mongo green; documented in USAGE.md.
- Frontend: all tests pass; `tsc` clean; `vite build` succeeds; the manual smoke list above all works.
