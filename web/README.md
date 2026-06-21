# Timber Console

A SaaS-quality internal log console for [Timber](../README.md) — fast structured
search, faceted finding ("errors by user", "by service"), curated + saved views,
a live tail, an expandable request/response inspector, a stats dashboard (volume,
error rate, AI cost/tokens, latency), and an in-app API reference.

It is a client-side SPA (TanStack Router + React + TypeScript, Vite). The read key
lives in `localStorage`; the app talks to the existing Timber query API over
**relative URLs**, so there is no CORS — in dev Vite proxies the API, in prod the
same nginx that serves these static files proxies it. The server hot path
(ingest/WAL/flusher) is untouched; the console only reads.

> The zero-dependency vanilla UI at the server's `/` still ships as a fallback.
> This console is the richer, build-step UI.

## Prerequisites

- Node ≥ 22 and a Timber server reachable on **`http://localhost:7710`** (the
  console proxies `/v1` and `/healthz` there in dev).
- For real data you also need MongoDB (queries answer `503` without it). Ingest a
  few events first so there is something to explore.

### 1. Start the Timber server (port 7710)

From the **repo root** (one directory up), either run it directly:

```bash
# repo root
export TIMBER_KEYS='[{"key":"w-dev-CHANGE_ME","app":"demo","env":"dev","mode":"write"},
                     {"key":"r-dev-CHANGE_ME","app":"*","env":"*","mode":"read"}]'
export MONGODB_URI='mongodb://localhost:27017'   # required for the query endpoints
node src/server.js
```

…or via Docker Compose (also binds `:7710`):

```bash
# repo root
cp .env.example .env   # set TIMBER_KEYS (+ MONGODB_URI) in it
docker compose up -d --build
```

Optionally seed a couple of events so the console isn't empty:

```bash
curl -s -X POST http://localhost:7710/v1/logs \
  -H 'Authorization: Bearer w-dev-CHANGE_ME' -H 'Content-Type: application/json' \
  -d '{"event":"ai.request","ids":{"userEmail":"you@example.com"},
       "data":{"model":"claude-opus-4-8","costUsd":0.31,"latencyMs":4120,"status":200,
               "request":{"prompt":"hi"},"response":{"status":200,"text":"hello"}}}'
```

### 2. Run the console dev server

```bash
# this directory (web/)
npm install        # first time only
npm run dev        # Vite dev server with HMR, proxying /v1 + /healthz → :7710
```

Open the printed URL (default `http://localhost:5173`). On first run the Settings
dialog opens — paste a **read** key (`r-dev-…` above). The key is stored in
`localStorage`; "Test connection" pings `/healthz` + a 1-row logs query.

Pointing at a non-default server origin:

```bash
TIMBER_TARGET=http://some-host:7710 npm run dev   # change the dev proxy target
```

(Or set a full **API base URL** in Settings for a split-origin deploy — the
operator must add the proxy/CORS; the server adds none.)

## Build & preview (production bundle)

```bash
npm run build      # tsc -b (typecheck) + vite build → ./dist
npm run preview    # serve ./dist locally to sanity-check the build
```

Deploy `dist/` behind the same nginx that proxies the Timber API, so `/v1` and
`/healthz` resolve same-origin. `apiBaseUrl` in Settings overrides this for a
split-origin setup.

## Test

```bash
npm run test        # vitest run (jsdom + Testing Library + MSW), one-shot
npm run test:watch  # watch mode
npm run typecheck   # tsc -b, no emit
npm run lint        # eslint
```

The network is mocked with [MSW](https://mswjs.io). A **shared fixture + handler
set** lives in [`test/`](test/):

- [`test/fixtures.ts`](test/fixtures.ts) — PRD §5.2-style sample events
  (`ai.request` with a `data.request`/`data.response` pair + `ids.userEmail`,
  `db.query`, `cron.run`) plus canned responses for every endpoint, all typed
  against the `@/lib/types` contract.
- [`test/handlers.ts`](test/handlers.ts) — `defaultHandlers` answering
  `/v1/logs`, `/v1/stats`, `/v1/events`, `/v1/facets`, `/v1/groupby`, `/healthz`
  from those fixtures, plus `logsPages()` / `errorOn()` override helpers.
- [`test/msw-server.ts`](test/msw-server.ts) seeds the server with
  `defaultHandlers`, so `server.resetHandlers()` (in
  [`test/setup.ts`](test/setup.ts)) reverts to them after every test. Any test
  overrides a single endpoint per-case with `server.use(http.get(...))`.

## Layout

```
web/
  src/
    main.tsx, router.tsx           # bootstrap + route tree (/  /stats  /docs/$page)
    routes/   __root, explore, stats, docs.$page
    components/                    # FilterBar, LensRail, GroupByPanel, ResultsTable,
                                   # DetailPanel (+ JsonTree, ReqResView), MetricCards,
                                   # StatChart, SettingsDialog, …
    hooks/                         # useLogs (infinite), useLiveTail, useStats, useEvents,
                                   # useFacets, useGroupBy, useHealth
    lib/      api, types, filters, views, time, settings, theme
    content/docs/                  # the 8 in-app docs pages
    theme/tokens.css               # the one file to reskin (light + dark)
  test/                            # shared MSW fixtures + handlers + setup
```

## Notes

- **Filter state lives entirely in the URL** (`filters.ts` maps `Filters ↔
  URLSearchParams`), so any view is a shareable/bookmarkable link and
  back/forward replays filter history.
- **Theming** is CSS variables in `theme/tokens.css` (light + dark), toggled via
  `data-theme` and persisted to `localStorage`.
- **No CORS by design** — the console uses relative URLs; dev proxy / prod nginx
  do the routing so the framework-free server never grows CORS handling.
- Security: the read key can read whatever is stored in `data`. Keep secrets out
  of logs at the source (transport redaction); send IDs, not payloads.
