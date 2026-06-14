# Timber — usage & query recipes

Everything below is copy-paste bash. Set these two once per shell:

```bash
export TIMBER_URL=http://localhost:7710
export TIMBER_KEY=w-dd-prod-CHANGE_ME        # a key from TIMBER_KEYS (see "Keys" below)
```

All `/v1/*` endpoints are JSON and require `Authorization: Bearer <key>`.
`GET /healthz` and the UI page `GET /` need no auth.

---

## Keys

Keys live only in Timber's environment (`TIMBER_KEYS`, a JSON array):

```bash
export TIMBER_KEYS='[
  {"key":"w-dd-prod-CHANGE_ME","app":"dailyDashboard","env":"prod","mode":"write"},
  {"key":"w-scraper-prod-CHANGE_ME","app":"scraper","env":"prod","mode":"write"},
  {"key":"r-assistant-CHANGE_ME","app":"assistant","env":"prod","mode":"read"}
]'
```

- `mode: "write"` — can ingest (`POST /v1/logs`) **and** query. The key's `app` + `env`
  are stamped onto every event it sends; the request body can never set them.
- `mode: "read"` — query-only, across **all** apps (single-org tool). On a read key,
  `app`/`env` are labels for bookkeeping; they don't scope what it can see.
  A read key used on `POST /v1/logs` gets `403`.
- Unknown or missing key ⇒ `401`. Rotation = edit `TIMBER_KEYS`, restart the process.

---

## Ingest — `POST /v1/logs` (write key)

Body is one event object or an array of up to 500. Only `event` is required.

### One event

```bash
curl -i -X POST "$TIMBER_URL/v1/logs" \
  -H "Authorization: Bearer $TIMBER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"event":"cron.run","data":{"job":"candidateAlertScheduler","scanned":412,"alerted":9,"errors":0,"durationMs":8120}}'
```

```
HTTP/1.1 202 Accepted

{"accepted":1}
```

`202` means the events are durably in the write-ahead log — they survive a Timber
process crash and any MongoDB outage.

### A batch

```bash
curl -s -X POST "$TIMBER_URL/v1/logs" \
  -H "Authorization: Bearer $TIMBER_KEY" \
  -H "Content-Type: application/json" \
  -d '[
    {"event":"ai.request","ids":{"taskId":"6a2877f0"},
     "data":{"provider":"opusmax","model":"claude-opus-4-8","inputTokens":9120,
             "outputTokens":2330,"latencyMs":41200,"status":200,"costUsd":0.31}},
    {"event":"db.query","level":"warn","message":"slow visibility query",
     "data":{"collection":"taskBody","operation":"aggregate","latencyMs":2773,
             "keysExamined":39816,"docsExamined":4979}}
  ]'
```

```json
{"accepted":2}
```

### Envelope reference

| field | rules |
|---|---|
| `event` | **required** string, ≤ 200 chars, no control chars. Sender-defined taxonomy (`ai.request`, `db.query`, `cron.run`, …) |
| `level` | optional `debug`\|`info`\|`warn`\|`error`, default `info`. Drives retention (TTL) |
| `ts` | optional sender-clock timestamp, must be `Date.parse`-able. Server always stamps `receivedAt` itself |
| `message` | optional string; silently truncated to 512 chars |
| `ids` | optional object, ≤ 10 keys; values string/number/boolean (coerced to strings). Correlation ids: `requestId`, `taskId`, … |
| `data` | optional object, any JSON, ≤ `TIMBER_MAX_DATA_KB` serialized (default 64 KB). Oversize ⇒ stored as `{"_truncated":true,"_originalBytes":n,"_head":"<first 4096 chars>"}`. Fits full request/response payloads; multi-MB blobs should still be sent as IDs |

Any other top-level key ⇒ the whole batch is rejected with `400`. The server adds
`app`, `env` (from the key), `receivedAt`, `expiresAt` (per-level TTL) and `_id`.

Conventions (optional, power the stats rollups): `data.latencyMs`/`data.durationMs`,
`data.status` (≥ 400 counts as error), `data.costUsd`, `data.inputTokens`,
`data.outputTokens`.

### Ingest error responses

| status | when | body / headers |
|---|---|---|
| `400` | invalid JSON, empty array, or first invalid event in the batch | `{"error":"...","index":<first bad event>}` — fix, then retry the whole batch |
| `401` | unknown/missing key | header `WWW-Authenticate: Bearer` |
| `403` | read-mode key on ingest | `{"error":"..."}` |
| `413` | body > 1 MB or batch > 500 events | `{"error":"..."}` |
| `429` | WAL disk budget exceeded (Mongo down too long) | `{"error":"wal budget exceeded"}`, header `Retry-After: 5` — buffer and retry |

---

## Query — `GET /v1/logs` (read or write key)

Returns `{"items":[...],"nextCursor":"..."|null}`, newest-first
(`receivedAt` desc, `_id` desc tiebreak). Default `limit` 100, max 500.
Unknown query params are rejected with `400`.

```bash
# last warn/error events from one app
curl -s "$TIMBER_URL/v1/logs?app=dailyDashboard&level=warn,error&limit=50" \
  -H "Authorization: Bearer $TIMBER_KEY"
```

An item is the full stored doc, dates as ISO strings:

```json
{
  "items": [
    {
      "_id": "9f2c4b7a1e8d3c5f6a0b9d8e7f1a2b3c",
      "app": "dailyDashboard",
      "env": "prod",
      "event": "db.query",
      "level": "warn",
      "message": "slow visibility query",
      "data": { "collection": "taskBody", "latencyMs": 2773, "keysExamined": 39816 },
      "receivedAt": "2026-06-11T14:03:27.412Z",
      "expiresAt": "2026-09-09T14:03:27.412Z"
    }
  ],
  "nextCursor": null
}
```

### Filters

| param | meaning | example |
|---|---|---|
| `app`, `env` | exact match | `app=scraper&env=prod` |
| `level` | csv of `debug,info,warn,error` | `level=warn,error` |
| `event` | **prefix** match | `event=ai.` matches `ai.request` |
| `from`, `to` | `receivedAt` window — ISO-8601 or epoch-ms; `from` inclusive, `to` exclusive | `from=2026-06-11T00:00:00Z` |
| `ids.<key>` | exact correlation-id match | `ids.taskId=6a2877f0` |
| `data.<path>` | exact match on any nested path; numeric/boolean-looking values match number **or** string | `data.status=200` |
| `data.<path>__gte`, `__lte` | numeric range (combinable on one path) | `data.latencyMs__gte=30000` |
| `q` | case-insensitive regex over `message`, ≤ 256 chars; nested-quantifier patterns rejected (ReDoS guard, see below) | `q=timeout` |
| `limit` | 1..500, default 100 | `limit=500` |
| `cursor` | opaque `nextCursor` from the previous page | |

> **`q` regex safety (ReDoS policy).** `q` is a user-supplied regex evaluated server-side over `message`, and a read key is shared broadly (incl. AI assistants), so two defenses apply in depth:
> 1. **Parse-time rejection** of catastrophic-backtracking patterns: a capture/non-capture group immediately followed by an unbounded quantifier whose body is itself unbounded — e.g. `(a+)+`, `(a*)*`, `(.*)+`, `(\d+){2,}`, `(?:a+)+`, `((a+)+)+` — is rejected with `400 {"error":"q rejected: nested quantifiers risk catastrophic backtracking"}`. This is a conservative heuristic: ordinary searches (`timeout`, `^GET `, `user.*not found`, `(read|write) key`, `status=4\d\d`) are unaffected.
> 2. **Execution-time cap**: every read query (`/v1/logs`, `/v1/stats`, `/v1/events`) runs with MongoDB `maxTimeMS` = `TIMBER_QUERY_MAX_TIME_MS` (default `5000`, `0` disables). This bounds any backtracking that slips past the heuristic **and** plain unindexed collection scans, so no single read can pin a Mongo worker. `/v1/logs` has no mandatory time window, which makes the cap the load-bearing protection for full-scan queries.

```bash
# AI calls slower than 30 s in the last 24 h
curl -s "$TIMBER_URL/v1/logs?event=ai.&data.latencyMs__gte=30000&from=2026-06-10T15:00:00Z" \
  -H "Authorization: Bearer $TIMBER_KEY"

# everything one task touched, across apps
curl -s "$TIMBER_URL/v1/logs?ids.taskId=6a2877f0" \
  -H "Authorization: Bearer $TIMBER_KEY"

# expensive calls of one model (numeric range + exact data match)
curl -s "$TIMBER_URL/v1/logs?data.model=claude-opus-4-8&data.costUsd__gte=0.25&data.costUsd__lte=5" \
  -H "Authorization: Bearer $TIMBER_KEY"

# regex over message — URL-encode anything beyond a plain word
curl -s -G "$TIMBER_URL/v1/logs" --data-urlencode "q=ECONNREFUSED|timeout" \
  -H "Authorization: Bearer $TIMBER_KEY"
```

### Cursor walk (keyset pagination)

`nextCursor` is opaque and URL-safe — pass it back verbatim; `null` means last page.

```bash
# page 1
curl -s "$TIMBER_URL/v1/logs?app=scraper&limit=100" -H "Authorization: Bearer $TIMBER_KEY"
# → {"items":[...100...],"nextCursor":"eyJyIjoiMjAyNi0wNi0xMVQxNDowMzoyNy40MTJaIiwiaSI6IjlmMmM0YjdhMWU4ZDNjNWY2YTBiOWQ4ZTdmMWEyYjNjIn0"}

# page 2 — paste nextCursor as-is
curl -s "$TIMBER_URL/v1/logs?app=scraper&limit=100&cursor=eyJyIjoiMjAyNi0wNi0xMVQxNDowMzoyNy40MTJaIiwiaSI6IjlmMmM0YjdhMWU4ZDNjNWY2YTBiOWQ4ZTdmMWEyYjNjIn0" \
  -H "Authorization: Bearer $TIMBER_KEY"
```

Full drain as a loop (requires `jq`):

```bash
CURSOR=""
while :; do
  URL="$TIMBER_URL/v1/logs?app=scraper&limit=500"
  [ -n "$CURSOR" ] && URL="$URL&cursor=$CURSOR"
  PAGE=$(curl -s "$URL" -H "Authorization: Bearer $TIMBER_KEY")
  echo "$PAGE" | jq -c '.items[]'
  CURSOR=$(echo "$PAGE" | jq -r '.nextCursor // empty')
  [ -z "$CURSOR" ] && break
done
```

Query endpoints answer `503 {"error":"storage unavailable"}` while MongoDB is
unreachable (ingest keeps working regardless).

---

## Stats — `GET /v1/stats` (read or write key)

Time-bucketed rollups. Params: `group=hour|day` (default `hour`), `from`/`to`
(default: last 24 h), `app` (exact), `event` (prefix). Unknown params ⇒ `400`.

```bash
# AI usage per hour, yesterday
curl -s "$TIMBER_URL/v1/stats?group=hour&event=ai.&from=2026-06-10T00:00:00Z&to=2026-06-11T00:00:00Z" \
  -H "Authorization: Bearer $TIMBER_KEY"
```

```json
{
  "group": "hour",
  "from": "2026-06-10T00:00:00.000Z",
  "to": "2026-06-11T00:00:00.000Z",
  "buckets": [
    {
      "bucket": "2026-06-10T13:00:00.000Z",
      "total": 412,
      "counts": { "debug": 0, "info": 398, "warn": 11, "error": 3 },
      "latency": { "p50": 1810, "p95": 24100, "p99": 41200 },
      "errorRate": 0.03,
      "costUsd": 4.12033,
      "inputTokens": 912000,
      "outputTokens": 233000
    }
  ]
}
```

How buckets are computed (all from the `data` conventions — absent keys never break):

- `total` / `counts` — event counts in the bucket, per level.
- `latency` — p50/p95/p99 over `data.latencyMs` (falls back to `data.durationMs`);
  `null` when no event in the bucket carried either key.
- `errorRate` — among events carrying `data.status`: share with `status >= 400`;
  `null` when none carried a status.
- `costUsd` — sum of `data.costUsd`, rounded to 6 decimals.
- `inputTokens` / `outputTokens` — sums.

```bash
# daily totals for one app, last week
curl -s "$TIMBER_URL/v1/stats?group=day&app=dailyDashboard&from=2026-06-04T00:00:00Z" \
  -H "Authorization: Bearer $TIMBER_KEY"
```

---

## Event names — `GET /v1/events` (read or write key)

Distinct `event` names seen per app (drives the UI filter dropdowns).

```bash
curl -s "$TIMBER_URL/v1/events" -H "Authorization: Bearer $TIMBER_KEY"
```

```json
{
  "apps": {
    "dailyDashboard": ["ai.request", "cron.run", "db.query"],
    "scraper": ["scrape.page", "scrape.run"]
  }
}
```

Scope to one app:

```bash
curl -s "$TIMBER_URL/v1/events?app=scraper" -H "Authorization: Bearer $TIMBER_KEY"
```

---

## Facet keys — `GET /v1/facets` (read or write key)

Which `ids.<key>` and `data.<path>` keys actually occur in a time window — so a UI
(or you) can discover the correlation ids and payload fields available to filter on
without knowing the schema up front. Params: `from`/`to` (ISO-8601 or epoch-ms;
default: last 24 h), `app` (exact). Unknown params ⇒ `400`.

```bash
curl -s "$TIMBER_URL/v1/facets?app=dailyDashboard&from=2026-06-11T00:00:00Z&to=2026-06-12T00:00:00Z" \
  -H "Authorization: Bearer $TIMBER_KEY"
```

```json
{
  "window": { "from": "2026-06-11T00:00:00.000Z", "to": "2026-06-12T00:00:00.000Z" },
  "idsKeys": ["requestId", "taskId", "userEmail"],
  "dataPaths": ["costUsd", "latencyMs", "model", "status"]
}
```

- `window` — the resolved scan window (echoes the defaults when `from`/`to` are omitted).
- `idsKeys` — distinct keys seen under `ids` across matching events, sorted.
- `dataPaths` — distinct top-level keys seen under `data`, sorted.

Use a discovered key to drill in with `/v1/logs` (`ids.userEmail=…`) or to break a
window down with `/v1/groupby` (below).

---

## Group & count — `GET /v1/groupby` (read or write key)

Count documents grouped by a single field, over the **same filter surface as
`/v1/logs`** — for "errors by user", "volume by service", "spend by model" style
breakdowns. Returns the top groups by count plus an `otherCount` rollup of the tail.

Params:

| param | meaning |
|---|---|
| `by` | **required** field to group on: `app`, `env`, `level`, `event`, or any `ids.<key>` / `data.<path>`. Anything else (incl. `$`-prefixed injection) ⇒ `400 {"error":"invalid by field"}` |
| `limit` | number of groups returned, 1..100, default 20. The rest fold into `otherCount` |
| `like` | optional case-insensitive substring filter on the **grouped values** (value autocomplete), ≤ 128 chars |
| *filters* | every `/v1/logs` filter applies: `app`, `env`, `level`, `event`, `from`/`to`, `q`, `ids.<key>`, `data.<path>` (+ `__gte`/`__lte`). `cursor` is not accepted |

```bash
# which users hit the most errors in the last 24 h
curl -s "$TIMBER_URL/v1/groupby?by=ids.userEmail&level=error" \
  -H "Authorization: Bearer $TIMBER_KEY"
```

```json
{
  "by": "ids.userEmail",
  "total": 137,
  "groups": [
    { "value": "alice@example.com", "count": 54 },
    { "value": "bob@example.com",   "count": 31 }
  ],
  "otherCount": 52
}
```

- `total` — documents matched by the filter (sum across **all** groups, before `limit`).
- `groups` — the top `limit` groups, count-desc (ties broken by value asc).
- `otherCount` — `total` minus the shown groups' counts (`0` when nothing was dropped).

```bash
# event volume by service (app), last hour
curl -s "$TIMBER_URL/v1/groupby?by=app&from=2026-06-11T13:00:00Z&to=2026-06-11T14:00:00Z" \
  -H "Authorization: Bearer $TIMBER_KEY"

# spend leaders by model, narrowed to model names containing "opus"
curl -s "$TIMBER_URL/v1/groupby?by=data.model&like=opus&event=ai." \
  -H "Authorization: Bearer $TIMBER_KEY"
```

---

## Health — `GET /healthz` (no auth)

```bash
curl -s "$TIMBER_URL/healthz"
```

```json
{
  "ok": true,
  "wal": { "totalBytes": 1048576, "backlogBytes": 0, "overBudget": false },
  "flusher": { "running": true, "caughtUp": true, "flushedTotal": 18234, "lastError": null },
  "mongo": { "connected": true }
}
```

How to read it:

| field | healthy | when it's not |
|---|---|---|
| `wal.backlogBytes` | ~0 | growing ⇒ Mongo is down or the flusher is behind; events are safe in the WAL |
| `wal.overBudget` | `false` | `true` ⇒ WAL hit `TIMBER_WAL_BUDGET_MB`; ingest is answering `429` until it drains |
| `flusher.caughtUp` | `true` | `false` ⇒ WAL replay/drain in progress (normal right after boot) |
| `flusher.lastError` | `null` | last Mongo insert error message — the flusher retries with backoff |
| `mongo.connected` | `true` | `false` ⇒ query endpoints answer `503`; ingest unaffected |

---

## UI — `GET /`

Open `http://localhost:7710/` in a browser, paste a key (stored in localStorage):
filters, live tail, expandable JSON rows, stats strip.

---

## Read-only key for an AI assistant

Goal: let an assistant answer "what happened?" during a debugging session without
giving it SSH or database access.

1. Add a read key to `TIMBER_KEYS` and restart Timber:

   ```json
   {"key":"r-assistant-CHANGE_ME","app":"assistant","env":"prod","mode":"read"}
   ```

2. Hand the key over out-of-band (never commit it; it never appears in log output).

3. The assistant can now run, for example:

   ```bash
   export TIMBER_URL=https://timber.internal.example.com
   export TIMBER_KEY=r-assistant-CHANGE_ME

   # what's breaking right now?
   curl -s "$TIMBER_URL/v1/logs?level=error&from=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)" \
     -H "Authorization: Bearer $TIMBER_KEY"

   # follow one request across apps
   curl -s "$TIMBER_URL/v1/logs?ids.requestId=req-8f31" -H "Authorization: Bearer $TIMBER_KEY"

   # AI spend today, hour by hour
   curl -s "$TIMBER_URL/v1/stats?event=ai.&from=$(date -u +%Y-%m-%dT00:00:00Z)" \
     -H "Authorization: Bearer $TIMBER_KEY"

   # what event taxonomies exist?
   curl -s "$TIMBER_URL/v1/events" -H "Authorization: Bearer $TIMBER_KEY"
   ```

The key can read every app's logs but cannot write (`POST` ⇒ `403`), and grants no
access to the VM, the WAL files, or MongoDB itself. Logs carry IDs, not payloads
(transcripts/resumes/email bodies are never logged), and transports mask
secret-looking keys before sending.

---

## Environment variables

| variable | default | meaning |
|---|---|---|
| `PORT` | `7710` | HTTP listen port |
| `TIMBER_HOST` | `0.0.0.0` | bind address (PRD §10: internal network behind nginx). Set `127.0.0.1` for a host-only run |
| `MONGODB_URI` | *(unset)* | Mongo/Atlas connection string. Unset ⇒ ingest works (WAL only), queries `503`, flusher idles |
| `TIMBER_DB` | `appLogs` | Mongo database name |
| `TIMBER_COLLECTION` | `events` | Mongo collection name |
| `TIMBER_MAX_DATA_KB` | `64` | max serialized `data` size per event (KB), clamp 1..15360; oversize truncates to a stored head. Raise to fit larger request/response payloads |
| `TIMBER_KEYS` | `[]` | JSON array `[{key,app,env,mode}]`, `mode` = `write`\|`read`. Empty ⇒ startup warning, every authed request `401` |
| `TIMBER_WAL_DIR` | `./wal-data` | WAL directory (`/data/wal` in the Docker image) |
| `TIMBER_WAL_BUDGET_MB` | `2048` | WAL disk cap; beyond it ingest answers `429` + `Retry-After` |
| `TIMBER_WAL_FSYNC_MS` | `50` | group-commit fsync cadence, clamped 1..1000 — the max whole-VM power-loss window |
| `TIMBER_WAL_SEGMENT_MB` | `64` | WAL segment rotation size |
| `TIMBER_WAL_RETAIN_HOURS` | `24` | flushed segments are kept this long before the janitor deletes them |
| `TIMBER_TTL_DEBUG_DAYS` | `7` | Mongo retention for `debug` events |
| `TIMBER_TTL_INFO_DAYS` | `30` | … for `info` |
| `TIMBER_TTL_WARN_DAYS` | `90` | … for `warn` |
| `TIMBER_TTL_ERROR_DAYS` | `90` | … for `error` |
| `TIMBER_FLUSH_BATCH` | `1000` | flusher `insertMany` batch size, clamped 1..1000 |
| `TIMBER_FLUSH_INTERVAL_MS` | `200` | flusher idle poll interval |
| `TIMBER_QUERY_MAX_TIME_MS` | `5000` | server-side `maxTimeMS` cap on read queries (regex/scan guard); `0` disables |
| `TIMBER_CLUSTER` | `0` | `>0` forks N workers (`node:cluster`), one WAL subdir per worker. Off by default |

---

## Status code reference

| status | endpoint(s) | meaning |
|---|---|---|
| `200` | queries, healthz, UI | OK |
| `202` | `POST /v1/logs` | `{"accepted":n}` — durably in the WAL |
| `400` | all | invalid envelope (`{"error":...,"index":n}`), bad JSON, or bad query param |
| `401` | all `/v1/*` | unknown/missing key (every `/v1/*` 401 sends `WWW-Authenticate: Bearer`) |
| `403` | `POST /v1/logs` | read-mode key cannot ingest |
| `404` | * | `{"error":"not found"}` |
| `413` | `POST /v1/logs` | body > 1 MB or batch > 500 events |
| `429` | `POST /v1/logs` | `{"error":"wal budget exceeded"}` + `Retry-After: 5` |
| `503` | `GET /v1/*` queries | `{"error":"storage unavailable"}` — Mongo unreachable |
