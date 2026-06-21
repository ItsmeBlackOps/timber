# Timber

Central log service for all internal apps: one ingest API, one query API, one tiny
UI. Every app ships structured events (`{event, level, message, ids, data}`) to a
single endpoint, and every nested `data` path is queryable with zero schema
registration — AI request metrics, slow-query timings, cron results, anything.

It is framework-free on purpose: pure `node:http`, the only runtime dependency is
the official `mongodb` driver, tests are `node:test`. The hot path never touches
the database — events are appended to a local write-ahead log (group-commit fsync
≤ 50 ms) and acked `202`; a background flusher batches them into MongoDB Atlas and
only then advances its checkpoint. A `202` therefore survives a process crash and
any Mongo outage (the WAL replays on boot), while ingest stays fast under heavy
parallel load (target: ≥ 2,000 events/s, p99 ack ≤ 25 ms).

Why it exists: production debugging used to mean SSH and `docker logs`, and AI
(Opus) usage had no queryable trace at all. Timber is the single place to ask
"what happened?" — for a human via the UI, or for an AI assistant holding a
read-only API key. Full spec: [PRD.md](PRD.md) · API recipes: [USAGE.md](USAGE.md).

## Architecture

```
apps ──HTTP──▶ node:http server ──append──▶ WAL (NDJSON segment files, local disk)
                                              │ fsync <= 50ms cadence; 202 after enqueue
                                              ▼ background flusher (batches of <= 1000)
                                        MongoDB Atlas, db `appLogs`
                                              ▲
UI (static, vanilla JS) + query API ──────────┘
```

## Quickstart

Requires Node ≥ 22. MongoDB is optional for ingest, required for queries
(MongoDB ≥ 7.0 — stats use `$percentile`).

```bash
npm ci

# 1. configure keys (and optionally Mongo — e.g. docker run -d -p 27017:27017 mongo:8)
export TIMBER_KEYS='[{"key":"w-dev-CHANGE_ME","app":"demo","env":"dev","mode":"write"}]'
export MONGODB_URI='mongodb://localhost:27017'   # omit ⇒ ingest-only, queries answer 503

# 2. run
node src/server.js

# 3. ingest — 202 means durably in the WAL
curl -i -X POST http://localhost:7710/v1/logs \
  -H 'Authorization: Bearer w-dev-CHANGE_ME' \
  -H 'Content-Type: application/json' \
  -d '{"event":"demo.hello","message":"first event","data":{"latencyMs":12}}'
# HTTP/1.1 202 Accepted
# {"accepted":1}

# 4. query it back (any filter on data.* works)
curl -s 'http://localhost:7710/v1/logs?app=demo&event=demo.' \
  -H 'Authorization: Bearer w-dev-CHANGE_ME'

# 5. UI: open http://localhost:7710/ and paste the key
```

All configuration is via environment variables (`PORT`, `MONGODB_URI`,
`TIMBER_KEYS`, `TIMBER_WAL_DIR`, `TIMBER_WAL_BUDGET_MB`, per-level
`TIMBER_TTL_*_DAYS`, …) — full table in [USAGE.md](USAGE.md#environment-variables).

### Docker

```bash
cp .env.example .env   # then set TIMBER_KEYS (+ MONGODB_URI) in it
docker compose up -d --build
curl -s http://localhost:7710/healthz
```

The WAL lives on the named volume `timber-wal`, so accepted-but-unflushed events
survive container restarts.

**Auto-deploy (CD).** The stack includes a
[Watchtower](https://containrrr.dev/watchtower/) service that polls Docker Hub and,
whenever a new `TIMBER_IMAGE` is pushed, pulls it and recreates the `timber`
container with the same env + `timber-wal` volume — so a `docker push` (from CI or
devops) rolls out to the VM with no SSH. It is label-scoped to **only** the
`timber` container (never `mongo` or other host containers). Tune the cadence with
`WATCHTOWER_POLL_INTERVAL` (default 300s); pause it with `docker compose stop
watchtower`.

## Console

A richer web console lives in [`web/`](web/) — a TanStack-Router + Vite SPA for
searching/viewing logs: structured + free-text search, faceted finding ("errors
by user", "by service"), curated + saved views (the URL is the shareable saved
search), a live tail, an expandable request/response inspector, a stats dashboard
(volume, error rate, AI cost/tokens, latency), and an in-app API reference. It is
read-only and client-side (read key in `localStorage`); it consumes the query API
over relative URLs (Vite proxy in dev / nginx in prod — no CORS), so the
framework-free server is untouched. The zero-dep vanilla UI at `/` stays as a
fallback.

```bash
node src/server.js                       # repo root: run the API on :7710 (needs MONGODB_URI for queries)
cd web && npm install && npm run dev     # console dev server, proxying /v1 + /healthz → :7710
```

Then open the printed URL and paste a **read** key. Build with `cd web && npm run
build` (output in `web/dist/`, served same-origin behind nginx). Full setup,
testing, and deploy notes: [`web/README.md`](web/README.md).

Two additive read endpoints back the console's faceting — `GET /v1/facets`
(discover `ids.*` / `data.*` field names) and `GET /v1/groupby` (counts per value,
e.g. "errors by user"); both are documented in [USAGE.md](USAGE.md).

## Tests & benchmarks

```bash
npm test                                  # unit + e2e (no external services needed)
TIMBER_TEST_MONGODB_URI=mongodb://localhost:27017 npm test   # + real-Mongo integration suite

node bench/ingest-bench.js                # acceptance: ≥2000 ev/s, p99 ack ≤ 25 ms
node bench/kill-test.js                   # SIGKILL mid-stream ⇒ zero acked-event loss (WAL mode)
MONGODB_URI=mongodb://localhost:27017 node bench/kill-test.js   # + replay/idempotency proof
```

CI (GitHub Actions) runs the test suite against a `mongo:8` service container plus
a bench smoke (`BENCH_SMOKE=1`) on every push and PR.

## Repo map

- `src/server.js` — entrypoint: HTTP routes, wiring, graceful shutdown
- `src/wal/` — segment writer (group-commit fsync), reader, checkpoint
- `src/flusher.js` — WAL → Mongo `insertMany`, checkpoint advance, boot replay
- `src/query/` — `/v1/logs` filters + keyset cursor, `/v1/stats`, `/v1/events`, `/v1/facets`, `/v1/groupby`
- `src/ui/index.html` — the fallback UI (vanilla JS, no build step)
- `web/` — the Timber Console SPA (TanStack Router + Vite); see `web/README.md`
- `bench/` — load generator, ingest bench, kill-test
- `PRD.md` — product spec · `USAGE.md` — endpoint recipes & env reference
