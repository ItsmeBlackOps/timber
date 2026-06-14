# Timber Console — frontend design spec

> Status: approved-in-design 2026-06-14. A standalone web frontend for viewing/searching Timber logs.
> Consumes the existing Timber query API (see [PRD.md](../../../PRD.md) §6 and the server in `src/`). The server is NOT modified by this project.

## 1. Goal

A polished, fast, internal log-viewing frontend ("Timber Console") with full search, a live tail, expandable JSON detail, and a stats dashboard (including AI cost/token rollups). Single-page app, client-side read-key auth, light + dark themes.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Framework | TanStack Router + Vite + React + TypeScript (client SPA — read key is client-side, SSR buys nothing) |
| Scope | Full dashboard: Explore (search/tail/detail) + Stats (volume, error rate, AI cost/tokens, latency) |
| AI cost | Part of the Stats page (no separate page) |
| Relationship to built-in UI | Standalone app in `web/`. The zero-dep vanilla UI at `/` (served by the server) stays as a fallback. |
| Themes | Light + dark with a toggle, persisted to localStorage |
| Server changes | None. Dev uses a Vite proxy; prod is served same-origin behind nginx. No CORS work, server stays framework-free. |

## 3. Non-goals (v1)

- No ingestion/writing from the UI (read-only console; write keys never entered here).
- No user accounts/RBAC — auth is a single pasted read key (matches PRD §6.3).
- No saved-search persistence beyond the URL (the URL *is* the shareable saved search).
- No alerting/notifications (PRD phase 2).
- No SSR/RSC, no server framework added.

## 4. Stack & dependencies

Runtime: `react`, `react-dom`, `@tanstack/react-router`, `@tanstack/react-query`, `@tanstack/react-virtual`, `recharts`, `lucide-react`.
Styling: `tailwindcss@^4` + `@tailwindcss/vite`, theme via CSS variables.
Build/dev: `vite`, `typescript`, `@vitejs/plugin-react`.
Test: `vitest`, `@testing-library/react`, `@testing-library/user-event`, `jsdom`, `msw`. Optional e2e: `@playwright/test`.

Each dependency justified: react-query (caching + `useInfiniteQuery` cursor pagination + `refetchInterval` tail/health), react-virtual (10k+ row scroll), recharts (stats charts), tailwind v4 (token theming), msw (API mocking in tests). No state-management lib (react-query + URL state suffice). No component kit (hand-rolled with Tailwind; lucide for icons).

## 5. Project layout

```
web/
  package.json            # separate from the root server package.json
  vite.config.ts          # react + tailwind plugins; dev proxy for /v1 and /healthz
  tsconfig.json
  index.html
  src/
    main.tsx              # router + QueryClient providers
    router.tsx            # route tree
    routes/
      __root.tsx          # app shell: top bar (brand, nav, health dot, theme, settings)
      explore.tsx         # "/" — filter bar + virtualized results + detail
      stats.tsx           # "/stats" — charts
    lib/
      api.ts              # typed fetch client (base URL + Bearer); endpoint fns
      types.ts            # LogDoc, LogsResponse, StatsResponse, EventsResponse, Health
      filters.ts          # Filters <-> URLSearchParams (mirrors server C8 contract)
      time.ts             # range presets, relative/absolute formatting
      settings.ts         # localStorage: key, apiBaseUrl, theme, tailIntervalMs
    hooks/
      useLogs.ts          # useInfiniteQuery over /v1/logs
      useLiveTail.ts      # page-1 polling + merge/dedupe by _id
      useStats.ts         # /v1/stats
      useEvents.ts        # /v1/events (app + event-name suggestions)
      useHealth.ts        # /healthz (refetchInterval)
    components/
      FilterBar.tsx, LevelChips.tsx, EventCombobox.tsx, TimeRangePicker.tsx,
      AdvancedFilters.tsx, ResultsTable.tsx (virtualized), LogRow.tsx,
      DetailPanel.tsx, StatChart.tsx, MetricCards.tsx, HealthDot.tsx,
      SettingsDialog.tsx, ThemeToggle.tsx, Banner.tsx (401/503/offline)
    theme/
      tokens.css          # CSS variables for light + dark (the approved palette)
  test/                   # vitest + RTL + msw; fixtures + handlers
```

## 6. API contract consumed (from the running server)

Auth header on every request: `Authorization: Bearer <readKey>`.

- `GET /v1/logs?<filters>` → `200 { items: LogDoc[], nextCursor: string | null }`. Newest-first.
- `GET /v1/stats?group=hour|day&from&to&app&event` → `200 { group, from, to, buckets: StatsBucket[] }`.
- `GET /v1/events?app?` → `200 { apps: { [app: string]: string[] } }`.
- `GET /healthz` (no auth) → `200 { ok, wal:{totalBytes,backlogBytes,overBudget}, flusher:{running,caughtUp,flushedTotal,lastError}, mongo:{connected} }`.
- Error statuses to handle: `400 {error, index?}` (bad param), `401` (unknown/missing key, sends `WWW-Authenticate: Bearer`), `503 {error}` (storage unavailable — Mongo not connected).

Types:
```ts
type Level = 'debug' | 'info' | 'warn' | 'error';
interface LogDoc { _id: string; app: string; env: string; event: string; level: Level;
  ts?: string; message?: string; ids?: Record<string,string>; data?: unknown;
  receivedAt: string; expiresAt: string; }   // receivedAt/expiresAt are ISO-8601
interface LogsResponse { items: LogDoc[]; nextCursor: string | null }
interface StatsBucket { bucket: string; total: number; counts: Record<Level,number>;
  latency: { p50:number; p95:number; p99:number } | null; errorRate: number | null;
  costUsd: number; inputTokens: number; outputTokens: number }
interface StatsResponse { group:'hour'|'day'; from:string; to:string; buckets: StatsBucket[] }
interface EventsResponse { apps: Record<string,string[]> }
```

## 7. Filters → query params (mirror of server contract C8)

`filters.ts` maps a `Filters` object to `URLSearchParams` and back. All filter state is held in the TanStack Router search params (the URL), so searches are shareable/bookmarkable and back/forward navigate filter history.

| Filter UI | Param emitted |
|---|---|
| app (select, from `/v1/events`) | `app=<exact>` |
| env (optional) | `env=<exact>` |
| levels (chips debug/info/warn/error) | `level=<csv of selected>` (omitted when all/none selected = no filter) |
| event prefix (combobox) | `event=<prefix>` |
| free-text search | `q=<regex>` (over `message`; ≤256 chars; UI shows a hint it is a regex) |
| time range (preset or custom) | `from=<ISO>` + `to=<ISO>` (presets: 15m, 1h, 6h, 24h, 7d, custom) |
| correlation id rows | `ids.<key>=<value>` |
| data path rows, op `=` | `data.<path>=<value>` |
| data path rows, op `≥`/`≤` | `data.<path>__gte=<n>` / `data.<path>__lte=<n>` (numeric) |
| page size | `limit=<1..500>` (default 100) |
| pagination | `cursor=<opaque>` (managed by `useInfiniteQuery`, not user-facing) |

A `400` from the server (e.g. invalid regex, bad numeric) surfaces inline on the offending control with the server's `error` text.

## 8. Views & behavior

### 8.1 App shell (`__root.tsx`)
Top bar: brand, nav tabs (Explore / Stats), health dot (green/red from `/healthz`, tooltip shows wal backlog + flusher + mongo state), theme toggle, settings gear. First run (no key) → Settings dialog auto-opens.

### 8.2 Explore (`/`)
- FilterBar (all controls in §7), URL-synced.
- ResultsTable: virtualized (`@tanstack/react-virtual`), columns Time (relative, absolute on hover) · Level (colored chip) · App · Event (mono) · Message (truncated). Infinite scroll via `useInfiniteQuery` `getNextPageParam = last.nextCursor`; "Load more" sentinel.
- LogRow click → DetailPanel: full pretty JSON of the doc (ids, data, all fields), copy-JSON, copy-link-to-event (deep link by `ids.*` filter), and "filter by this value" on any leaf (adds a `data.<path>=` / `ids.<key>=` filter).
- Live tail toggle: when on, `useLiveTail` refetches page 1 every `tailIntervalMs` (default 2000) **only when `document.visibilityState==='visible'`**, prepends new `_id`s with a brief highlight, dedupes by `_id`, and auto-pauses while the user has scrolled away from the top.

### 8.3 Stats (`/stats`)
Range-linked to Explore (shares from/to). Renders from `/v1/stats`:
- Metric cards: total events, error rate %, AI cost (sum costUsd), p95 latency (last/representative bucket), total tokens.
- Charts (recharts): event volume per bucket stacked by level; error-rate % line; AI cost over time (bar) with running total; tokens (input/output) over time; latency p50/p95/p99 lines. Buckets with `latency:null`/`errorRate:null` render as gaps, not zero.
- Group toggle hour/day; app + event-prefix filters reuse FilterBar pieces.

### 8.4 Settings dialog
Fields: read key (password input), API base URL (default `''` = same-origin), theme (system/light/dark), tail interval. Persisted to `localStorage`. "Test connection" pings `/healthz` and a `limit=1` logs query to validate the key.

## 9. States & errors
- Loading: skeleton rows / chart placeholders.
- Empty: "no events match these filters" with a clear-filters action.
- `401`: top Banner "key invalid or missing" → opens Settings; queries paused until fixed.
- `503`: Banner "storage unavailable (Mongo not connected)"; tail/queries back off and retry.
- Offline/network error: Banner + react-query retry with backoff.

## 10. Theming
`theme/tokens.css` defines CSS variables for both modes (approved palette): indigo accent (`#4F46E5` light / `#838CF7` dark); neutral slate surfaces (app/panel/elevated/border); text primary+muted; level colors debug=slate, info=blue, warn=amber, error=red, each used as chip text over a tinted background. Theme is a `data-theme` attribute on `<html>` (`light`/`dark`), defaulting to system, overridable + persisted. Swapping the palette later = editing this one file.

## 11. Dev & prod serving (no CORS)
- Dev: `vite.config.ts` `server.proxy` forwards `/v1` and `/healthz` to `http://localhost:7710`. App calls same-origin relative URLs; key still required.
- Prod: `vite build` → `web/dist` static assets. Served same-origin behind the existing nginx gateway (PRD §10/§11), which also proxies `/v1` + `/healthz` to the Timber container. `apiBaseUrl` defaults to same-origin; settable for split-origin setups (then the operator must add a proxy — Timber itself adds no CORS).
- The built-in vanilla UI at `/` (served by the Node server) is untouched and remains the zero-build fallback.

## 12. Testing
- Component/integration (vitest + RTL + msw): filter↔URL mapping round-trips (every row in §7); infinite-scroll cursor walk (3 pages, no dup/gap); live-tail prepend + dedupe by `_id` + visibility gating; level chip rendering; DetailPanel JSON + "filter by value" wiring; Stats rendering incl. null latency/errorRate gaps; 401/503/empty/loading banners; theme toggle + settings persistence (localStorage).
- msw handlers model the real endpoints incl. `400 {error}` and cursor semantics, seeded from fixtures resembling PRD §5.2 examples (ai.request, db.query, cron.run).
- Optional e2e (Playwright): `vite preview` + msw or a seeded real server — load → filter → expand → tail → stats.
- Lint/typecheck: `tsc --noEmit`, `vitest run`.

## 13. Acceptance
- All §12 tests pass; `tsc` clean; `vite build` succeeds.
- Manual: against a seeded real server, search by app/level/event/`data.<path>` returns correct rows; cursor "load more" works; live tail streams; Stats charts populate; cost/tokens reflect ai.request data; 401/503 handled; theme persists.
