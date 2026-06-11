# Timber — product requirements document

> Centralized log service for all internal apps. One ingest API, one query API,
> one tiny UI. Fast, framework-free, and durable: an accepted record is never
> lost.
>
> Status: PRD approved-in-design, implementation not started.
> Decisions in this document were made with the owner on 2026-06-10/11.

---

## 1. Why

Today every app's logs die in `docker logs` on the VM. Debugging production
means SSH-ing into boxes, probing MongoDB and Appwrite by hand, or guessing.
There is no record of AI (Opus) usage at all — no tokens, no latency, no cost,
no failure history (a production 401 outage left zero queryable trace).

Timber is the single place every app ships structured events to, and the
single place a human (or an AI assistant with a read-only key) queries to
answer "what happened?".

## 2. Goals

1. **Any log, one contract.** A generic event envelope; the payload (`data`)
   is arbitrary JSON chosen by the sender — AI requests, DB query timings,
   cron results, webhook bodies, anything — with every `data` field queryable
   without schema registration or Timber redeploys.
2. **Very fast ingest under parallel load.** Many apps and many concurrent
   requests; ingestion must not become the bottleneck of any caller.
3. **Never lose an accepted record.** If Timber replied 202, the event
   survives a process crash or a database outage.
4. **No external web framework.** Pure `node:http`. The only runtime
   dependency is the official `mongodb` driver. Tests use built-in
   `node:test`. (Rationale: minimal attack/maintenance surface, no framework
   overhead on the hot path, and the exercise of owning the whole path.)
5. **Shareable.** A read-only API key lets a collaborator (including an AI
   assistant in a terminal) query logs without server or DB access.

## 3. Non-goals (v1)

- Multi-tenancy, signup, billing — this is a single-org internal tool.
  (`app` is the only namespace.)
- Alerting/notifications (the data model supports it; phase 2).
- Metrics/tracing standards (OTel) compatibility — may come later.
- Browser/frontend log ingestion (PostHog covers it today).
- Full-text search engine — `q` is a filtered-window regex match in v1.
- High availability — single container; durability comes from the WAL +
  Atlas, not redundancy.

## 4. Users

- **App backends** (writers): dailyDashboard backend (Node), scraper
  (Python), forge-ai (Python). All wired from day 1.
- **The owner** (reader): UI + query API for debugging and AI cost review.
- **AI assistant** (reader): query API with a read-only key, used during
  debugging sessions instead of SSH/DB probes.

## 5. The event contract

### 5.1 Envelope — only `event` is required

```jsonc
{
  "event":   "string",                  // REQUIRED. Sender-defined taxonomy: "ai.request", "db.query", "cron.run", ...
  "level":   "debug|info|warn|error",   // optional, default "info". Drives retention.
  "ts":      "ISO-8601",                // optional, sender clock. Server always stamps receivedAt itself.
  "message": "string",                  // optional human one-liner, <= 512 chars
  "ids":     { "<anyKey>": "string" },  // optional correlation ids: requestId, taskId, userEmail, jobId, ... <= 10 keys
  "data":    { /* any JSON */ }         // optional, <= 16 KB serialized. Entirely sender-defined.
}
```

Server adds: `app` + `env` (derived from the write key — never trusted from
the body), `receivedAt` (server clock), and a unique `_id`.

### 5.2 `data` is the product

Anything goes inside `data`, and every nested path is queryable
(`data.model`, `data.latencyMs`, `data.keysExamined`, ...). Three events from
three different worlds, same endpoint:

```jsonc
// an AI call
{ "event": "ai.request", "ids": { "taskId": "6a2877..." },
  "data": { "provider": "opusmax", "model": "claude-opus-4-8",
            "inputTokens": 9120, "outputTokens": 2330,
            "latencyMs": 41200, "status": 200, "costUsd": 0.31 } }

// a slow database query
{ "event": "db.query", "level": "warn", "message": "slow visibility query",
  "data": { "collection": "taskBody", "operation": "aggregate",
            "query": "{ interviewStartAt: {$gte..}, $or:[sender,cc regex] }",
            "latencyMs": 2773, "keysExamined": 39816, "docsExamined": 4979 } }

// a cron run
{ "event": "cron.run",
  "data": { "job": "candidateAlertScheduler", "scanned": 412, "alerted": 9,
            "errors": 0, "durationMs": 8120 } }
```

### 5.3 Conventions, not requirements

If these keys exist in `data`, the stats endpoints use them automatically;
if absent, nothing breaks:

| key | used for |
|---|---|
| `latencyMs` / `durationMs` | p50/p95/p99 latency per event |
| `status` | error-rate rollups (>=400 = error) |
| `costUsd` | cost per day / per `data.model` |
| `inputTokens` / `outputTokens` | token totals per day / model |

### 5.4 Size + hygiene rules

- `data` <= 16 KB serialized; oversize → event stored with `data` replaced by
  `{ _truncated: true, _originalBytes: n }` plus the first 4 KB raw.
- Batch <= 500 events, request body <= 1 MB.
- **IDs, not payloads:** transcripts, resumes, email bodies never go in logs —
  send their IDs. (Logs are shared; the repos are not all private.)
- Transport-side redaction: any `data`/`ids` key matching
  `/password|secret|token|apikey|api_key|authorization/i` is masked to
  `"***"` before sending.

## 6. API

All endpoints JSON. Auth: `Authorization: Bearer <key>`.

### 6.1 Ingest (write keys)

- `POST /v1/logs` — body is one event object or an array.
  - `202 { accepted: n }` once the events are durably in the WAL (§7).
  - `400` invalid envelope (the whole batch is rejected with the index of the
    first bad event; senders retry only after fixing).
  - `401` bad key. `413` too large. `429` + `Retry-After` under overload.
- `GET /healthz` — liveness (no auth). Includes WAL backlog depth.

### 6.2 Query (read or write keys)

- `GET /v1/logs` — filters: `app`, `env`, `level` (csv), `event` (prefix
  match: `event=ai.` matches `ai.request`), `from`/`to` (receivedAt),
  `ids.<key>=`, `data.<path>=` (exact), `data.<path>__gte/__lte=` (numeric),
  `q=` (regex over `message`), `limit` (<=500, default 100),
  `cursor` (opaque, receivedAt+_id keyset pagination). Sorted newest-first.
- `GET /v1/stats` — `?group=hour|day&from=&to=&app=&event=` → counts by
  level + the §5.3 convention rollups (latency percentiles, error rate,
  costUsd, tokens) per bucket.
- `GET /v1/events` — distinct `event` names seen per app (drives UI filters).

### 6.3 Keys

Keys live in Timber's env (`TIMBER_KEYS` JSON: `[{ key, app, env, mode:
"write"|"read" }]`). No key management UI in v1; rotation = edit env +
restart. Keys never appear in any repo or log output.

## 7. Architecture

```
apps ──HTTP──▶ node:http server ──append──▶ WAL (NDJSON segment files, local disk)
                                              │ fsync <= 50ms cadence; 202 after enqueue
                                              ▼ background flusher (batches of <= 1000)
                                        MongoDB Atlas, db `appLogs`
                                              ▲
UI (static, vanilla JS) + query API ──────────┘
```

### 7.1 Hot path: WAL-first ingestion (the speed + durability core)

1. Request parsed + validated + key-checked (all in-process, no I/O).
2. Events appended to the active **write-ahead log segment** — an append-only
   NDJSON file on local disk. Appends are serialized through a single
   writer; `fsync` runs on a <= 50 ms timer (group commit), and the `202`
   response is sent after the events are in the OS buffer of the WAL —
   meaning a Timber **process** crash loses nothing; only a whole-VM crash
   inside the fsync window can lose <= 50 ms of events (documented bound).
3. A background flusher reads the WAL forward and `insertMany`s into Mongo in
   batches (`ordered:false`). Only after Mongo acknowledges does the segment
   offset checkpoint advance. Mongo down → WAL simply grows (disk-capped,
   §7.3); ingestion stays up. On boot, unflushed WAL ranges are replayed —
   **this is the "never lose an accepted record" guarantee.**
4. Inserts are idempotent across replays: `_id` is derived
   deterministically (hash of app + receivedAt + body) so a replay after a
   crash between insert and checkpoint upserts, not duplicates.

### 7.2 Concurrency model

Single Node process, fully async; the hot path does no per-request disk
`fsync` and no per-request Mongo round-trip, so thousands of parallel
requests collapse into sequential WAL appends + batched inserts.
`node:cluster` (one worker per core, one WAL per worker) is a startup flag —
off by default, available if a single core ever saturates.

### 7.3 Backpressure + bounds

- WAL disk budget (default 2 GB): beyond it, ingest answers `429` +
  `Retry-After` rather than risking the disk. Transports buffer + retry.
- Mongo flusher falls behind → only the WAL backlog grows; `healthz` exposes
  the depth so it is visible.

### 7.4 Storage (MongoDB Atlas)

- Same Atlas cluster as the existing apps, new database **`appLogs`**,
  collection `events`. (Durable even if the VM dies. Revisit only if log
  volume ever pressures the cluster.)
- Indexes: `{receivedAt:-1}`, `{app:1, receivedAt:-1}`,
  `{event:1, receivedAt:-1}`, `{level:1, receivedAt:-1}`, sparse indexes on
  `ids.requestId`, `ids.taskId`.
- **Retention via TTL on `expiresAt`** (computed at insert from level):
  debug 7d, info 30d, warn/error 90d — env-tunable per level.

### 7.5 UI

One static page served by the same process (vanilla HTML/JS — no framework,
consistent with the ethos): filter bar (app/level/event/q/time), live tail
(2s poll), expandable JSON rows, and a stats strip (events/min, error rate,
AI cost today). Auth = paste a key (kept in localStorage).

## 8. Transports (live in the app repos, defined by this contract)

- **Node (dailyDashboard):** a tap on the existing `logger` util — everything
  it logs to stdout is *also* queued to Timber. Plus an `aiRequestLog`
  wrapper around the 4 AI services emitting `ai.request` with the §5.3 keys.
  Buffer in memory (cap 5k events, drop-oldest + a `transport.dropped`
  counter event), flush every 2 s or 100 events, never throw, never block a
  request, fall back silently if Timber is unreachable (stdout remains).
- **Python (scraper, forge-ai):** a ~60-line `logging.Handler` with the same
  batching/backoff semantics.
- Apps keep logging to stdout exactly as today. Timber is additive — an app
  must never fail because the log service is down.

## 9. Performance & durability targets (acceptance)

| target | bar |
|---|---|
| sustained ingest, single process, VM hardware | >= 2,000 events/s |
| p99 ingest ack (202) under that load | <= 25 ms |
| accepted-record loss on `kill -9` of Timber | 0 (WAL replay proves it) |
| accepted-record loss on Mongo outage <= WAL disk budget | 0 |
| max loss window on whole-VM power loss | <= 50 ms of events (fsync cadence) |
| query: filtered last-hour window | <= 500 ms typical |

Each bar gets a scripted check in the repo (`bench/` + `node:test`).

## 10. Security & privacy

- Repo **private**. Keys only in env. Read-only key shared out-of-band.
- The service binds to the VM's internal network; exposure via the existing
  nginx gateway under a dedicated host/port with TLS.
- No payload blobs (IDs-not-payloads rule, §5.4); transport-side redaction.
- WAL files contain raw events → same disk hygiene as the DB; segments
  deleted after checkpoint + 24 h.

## 11. Deployment

- This folder is a standalone repo (`timber`), Dockerfile + its own
  `docker-compose.yml` on the existing VM — separate stack from
  dailyDashboard, no blue/green (internal tool; durable state is in
  Atlas + WAL volume).
- Config via env: `MONGODB_URI`, `TIMBER_KEYS`, `TIMBER_WAL_DIR`,
  `TIMBER_WAL_BUDGET_MB`, `TIMBER_TTL_{DEBUG,INFO,WARN,ERROR}_DAYS`, `PORT`.
- CI: GitHub Actions — tests + bench smoke on PR; deploy = compose pull/up
  over SSH (reusing the known pattern, including its retry-on-255).

## 12. Milestones (each independently shippable)

1. **T1 — core ingest:** `node:http` server, key auth, envelope validation,
   WAL append + fsync cadence, 202 semantics, healthz. Bench: 2k events/s.
2. **T2 — durability:** Mongo flusher + checkpointing + boot replay +
   deterministic `_id` idempotency + TTL/indexes. Kill-test passes.
3. **T3 — query:** `/v1/logs` filters incl. `data.<path>`, keyset cursor,
   `/v1/stats` convention rollups, `/v1/events`. Read-only keys.
4. **T4 — transports + wiring:** Node tap + `ai.request` wrapper in
   dailyDashboard (every Opus call visible: tokens/latency/cost/status);
   Python handler in scraper + forge-ai.
5. **T5 — UI:** static page (tail, filters, stats strip).
6. **T6 — ops + sharing:** compose on VM behind the gateway, deploy workflow,
   read-only key handed to the AI assistant, `USAGE.md` with query recipes.

## 13. Open questions

- Remote: create the private GitHub repo now or after T1? (Default: now.)
- Gateway exposure: subdomain vs port on the existing host (owner's call at T6).
- Cost estimation table for `costUsd` (per-model rates) — lives in the
  transports, not Timber; needs the OpusMax rate card.

## 14. Explicitly rejected alternatives

- **Express/Fastify/Nest** — owner constraint: no external web framework.
- **Self-hosted OSS (SigNoz/Loki/OpenObserve)** — not owned, heavier ops,
  weaker fit for per-app API sharing (decided 2026-06-10).
- **Local-only NDJSON storage (no Mongo)** — fails the "VM dies, logs
  survive" requirement; the WAL keeps the speed benefit without giving up
  Atlas durability.
- **Kafka/queues/ClickHouse** — out of proportion to current volume; the
  WAL + batched `insertMany` covers the same failure modes at this scale.
