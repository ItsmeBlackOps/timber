# Logflare Dual-Write + Query Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Logflare as a parallel write target alongside Neon, expose a GET endpoint that queries Logflare via their Endpoints API, and document what is driving Vercel Pro resource consumption.

**Architecture:** The `ingest()` handler in `/v1/logs` fires a non-blocking `fetch` to Logflare in parallel with the Neon insert so the client response time is unaffected. A new `/v1/logflare` handler handles GET queries by proxying to a pre-configured Logflare Endpoint (a saved SQL query in Logflare's UI). Both new files follow the existing pattern: thin handler + pure helper module.

**Tech Stack:** Vercel Node.js serverless functions, `@neondatabase/serverless` (existing), `fetch` (native Node 18+), Logflare ingest API (`POST /api/logs`), Logflare Endpoints API (`GET /api/endpoints/query/:uuid`).

---

## Pre-flight: Vercel Resource Usage Investigation

Before writing any code, understand why timber is consuming significant Vercel Pro resources. This is diagnostic only.

### What to check in Vercel dashboard

Go to your Vercel project > Analytics > Functions tab:

1. **Function invocations:** The `dailyDashboard` app sends `db.query` events at ~1-2 per second (126k `notification_outbox` finds alone in the log sample). Each batch POST to `/v1/logs` = one Vercel function cold-start or warm-invocation. At ~200k DB events logged + ~26k HTTP events over ~30 hours of data, that implies **~8,000-10,000 function invocations per hour** if events are sent individually. If batched, far fewer.

2. **GB-hours:** Each `/v1/logs` POST makes one HTTPS round-trip to Neon (avg ~260ms per the latency data). Vercel bills execution time x memory. The function runs for ~300ms minimum per invocation at the default 1024 MB allocation.

3. **Bandwidth:** The `data` column averages 1.5 KB per `db.query` event, and the full MongoDB command/result is sent in the POST body. High bandwidth = high cost.

**Likely root cause:** `dailyDashboard` is logging every single MongoDB query (including the `notification_outbox` poll that fires every second on 3 worker processes). That is ~180 events/minute or ~260,000/day hitting your Vercel endpoint. Recommend the `dailyDashboard` team either:
- Sample `db.query` events (log 1 in 10 for polling queries)
- Only log `db.query` events where `durationMs > 200` or `level = error`
- Batch events more aggressively (send once every 5s, not per-query)

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `web/api/_lib/logflare.js` | Create | Logflare ingest helper: map timber event to Logflare batch payload, POST to API |
| `web/api/_lib/env.js` | Modify | Add `logflareConfig()` to read `LOGFLARE_SOURCE_ID` and `LOGFLARE_API_KEY` |
| `web/api/v1/logs.js` | Modify | Fire-and-forget `forwardToLogflare()` in parallel with Neon insert |
| `web/api/v1/logflare.js` | Create | GET handler: proxy search queries to Logflare Endpoints API |
| `web/vercel.json` | Modify | Add rewrite for `/v1/logflare` |
| `web/test/logflare.test.js` | Create | Unit tests for the logflare helper (no network calls) |

---

## Task 1: Add Logflare env config to `env.js`

**Files:**
- Modify: `web/api/_lib/env.js`

Two new env vars:
- `LOGFLARE_SOURCE_ID`: the UUID of the Logflare source (create one in Logflare UI at logflare.app)
- `LOGFLARE_API_KEY`: ingest-scoped API key from Logflare
- `LOGFLARE_ENDPOINT_ID`: UUID of the Logflare Endpoint for querying (set up in Task 4 setup step)

- [ ] **Step 1: Add `logflareConfig()` to `env.js`**

Open `web/api/_lib/env.js` and append at the bottom:

```js
export const logflareConfig = () => ({
  sourceId: process.env.LOGFLARE_SOURCE_ID ?? '',
  apiKey: process.env.LOGFLARE_API_KEY ?? '',
  endpointId: process.env.LOGFLARE_ENDPOINT_ID ?? '',
});
```

- [ ] **Step 2: Add env vars to Vercel project**

```bash
cd web
vercel env add LOGFLARE_SOURCE_ID production
# paste your Logflare source UUID when prompted

vercel env add LOGFLARE_API_KEY production
# paste your Logflare ingest API key when prompted

vercel env add LOGFLARE_ENDPOINT_ID production
# paste your Logflare endpoint UUID when prompted (create endpoint first - see Task 4 pre-step)
```

- [ ] **Step 3: Commit**

```bash
git add web/api/_lib/env.js
git commit -m "feat(logflare): add logflareConfig env reader"
```

---

## Task 2: Create Logflare ingest helper

**Files:**
- Create: `web/api/_lib/logflare.js`
- Create: `web/test/logflare.test.js`

Logflare's batch ingest format:
```json
POST https://api.logflare.app/api/logs?source=SOURCE_UUID
X-API-KEY: INGEST_TOKEN

{
  "batch": [
    { "message": "db.query", "metadata": { "app": "myapp", "level": "info", ... } }
  ]
}
```

The `message` field is the event name (Logflare requires it). All timber fields go into `metadata`.

- [ ] **Step 1: Write the failing test**

Create `web/test/logflare.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { buildLogflarePayload } from '../api/_lib/logflare.js';

describe('buildLogflarePayload', () => {
  const principal = { app: 'testapp', env: 'prod' };
  const now = new Date('2026-06-30T10:00:00.000Z');

  it('maps a single event to Logflare batch format', () => {
    const events = [
      { event: 'http.request', level: 'info', ts: '2026-06-30T09:59:00.000Z',
        data: { path: '/api/health', status: 200, latencyMs: 42 } }
    ];
    const payload = buildLogflarePayload(events, principal, now);
    expect(payload.batch).toHaveLength(1);
    const item = payload.batch[0];
    expect(item.message).toBe('http.request');
    expect(item.metadata.app).toBe('testapp');
    expect(item.metadata.env).toBe('prod');
    expect(item.metadata.level).toBe('info');
    expect(item.metadata.data.path).toBe('/api/health');
    expect(item.metadata.receivedAt).toBe('2026-06-30T10:00:00.000Z');
  });

  it('maps multiple events to a batch array', () => {
    const events = [
      { event: 'db.query', level: 'error', data: { error: 'dup key' } },
      { event: 'db.query', level: 'info', data: { durationMs: 120 } }
    ];
    const payload = buildLogflarePayload(events, principal, now);
    expect(payload.batch).toHaveLength(2);
    expect(payload.batch[0].metadata.level).toBe('error');
    expect(payload.batch[1].metadata.level).toBe('info');
  });

  it('omits null/undefined optional fields from metadata', () => {
    const events = [{ event: 'fn.timing', level: 'info' }];
    const payload = buildLogflarePayload(events, principal, now);
    const meta = payload.batch[0].metadata;
    expect(meta).not.toHaveProperty('message');
    expect(meta).not.toHaveProperty('ids');
    expect(meta).not.toHaveProperty('data');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test -- test/logflare.test.js
```

Expected: FAIL with `Cannot find module '../api/_lib/logflare.js'`

- [ ] **Step 3: Create `web/api/_lib/logflare.js`**

```js
// Logflare ingest helper. buildLogflarePayload is a pure function (testable
// without network). forwardToLogflare is fire-and-forget: it never throws and
// never blocks the Neon insert response path.
import { logflareConfig } from './env.js';

const LOGFLARE_URL = 'https://api.logflare.app/api/logs';

export function buildLogflarePayload(events, principal, now) {
  const receivedAt = now.toISOString();
  const batch = events.map((e) => {
    const metadata = {
      app: principal.app,
      env: principal.env ?? '',
      level: e.level,
      receivedAt,
    };
    if (e.ts != null) metadata.ts = new Date(e.ts).toISOString();
    if (e.message != null) metadata.message = e.message;
    if (e.ids != null) metadata.ids = e.ids;
    if (e.data != null) metadata.data = e.data;
    return { message: e.event, metadata };
  });
  return { batch };
}

export async function forwardToLogflare(events, principal) {
  const { sourceId, apiKey } = logflareConfig();
  if (!sourceId || !apiKey) return;
  const payload = buildLogflarePayload(events, principal, new Date());
  try {
    await fetch(`${LOGFLARE_URL}?source=${sourceId}`, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // fire-and-forget: log to stderr but never surface to caller
    console.error('[timber] logflare forward failed');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd web && npm test -- test/logflare.test.js
```

Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/api/_lib/logflare.js web/test/logflare.test.js
git commit -m "feat(logflare): add buildLogflarePayload helper + forwardToLogflare"
```

---

## Task 3: Wire dual-write into the ingest handler

**Files:**
- Modify: `web/api/v1/logs.js`

The key constraint: Logflare forward must not block the response. We use `Promise.allSettled` so Neon insert and Logflare forward race in parallel - the response is sent as soon as Neon confirms, regardless of Logflare.

Actually, we want Neon to be the source of truth - respond after Neon succeeds. Logflare is best-effort. So: start both in parallel, await Neon, ignore Logflare result.

- [ ] **Step 1: Modify `web/api/v1/logs.js` ingest function**

Replace the current `ingest` function (lines 13-25):

```js
import { json, badRequest, methodNotAllowed, readJson } from '../_lib/respond.js';
import { requireWrite, requireRead } from '../_lib/auth.js';
import { validateBatch } from '../_lib/validate.js';
import { ttlDays, limits } from '../_lib/env.js';
import { buildInsert } from '../_lib/ingest.js';
import { db } from '../_lib/db.js';
import { parseLogsQuery, runLogs } from '../_lib/sql/logs.js';
import { resolveScope } from '../_lib/projects.js';
import { forwardToLogflare } from '../_lib/logflare.js';

async function ingest(req, res) {
  const principal = requireWrite(req, res);
  if (!principal) return;
  const body = await readJson(req);
  if (!body.ok) return badRequest(res, 'invalid or empty JSON body');
  const v = validateBatch(body.value, limits());
  if (!v.ok) {
    return json(res, v.status ?? 400, v.index != null ? { error: v.error, index: v.index } : { error: v.error });
  }
  const { text, params } = buildInsert(v.events, principal, ttlDays(), new Date());
  // Run Neon insert and Logflare forward in parallel. Only Neon result matters
  // for the response; Logflare is best-effort and must never block the caller.
  const [neonResult] = await Promise.allSettled([
    db()(text, params),
    forwardToLogflare(v.events, principal),
  ]);
  if (neonResult.status === 'rejected') throw neonResult.reason;
  return json(res, 201, { accepted: v.events.length, rejected: 0 });
}

async function query(req, res) {
  if (!requireRead(req, res)) return;
  const sp = new URL(req.url, 'http://localhost').searchParams;
  const apps = await resolveScope(sp);
  const parsed = parseLogsQuery(sp, {});
  if (!parsed.ok) return badRequest(res, parsed.error);
  const result = await runLogs(parsed.value, apps);
  return json(res, 200, result);
}

export default async function handler(req, res) {
  if (req.method === 'POST') return ingest(req, res);
  if (req.method === 'GET') return query(req, res);
  return methodNotAllowed(res, 'GET, POST');
}
```

- [ ] **Step 2: Run full test suite**

```bash
cd web && npm test
```

Expected: all existing tests pass (the dual-write is additive; no logic changed for the Neon path).

- [ ] **Step 3: Commit**

```bash
git add web/api/v1/logs.js
git commit -m "feat(logflare): dual-write events to Logflare in parallel with Neon"
```

---

## Task 4: Create the Logflare GET query endpoint

### Pre-step: Create a Logflare Endpoint in the UI (manual, one-time)

Before writing code, set up the Logflare Endpoint that timber will proxy to:

1. Go to [logflare.app](https://logflare.app) > your source > Endpoints tab > New Endpoint
2. Name it `timber-search`
3. Paste this SQL (Logflare uses BigQuery SQL syntax):

```sql
SELECT
  timestamp,
  event_message,
  metadata.app,
  metadata.env,
  metadata.level,
  metadata.ts,
  metadata.message,
  metadata.ids,
  metadata.data,
  metadata.receivedAt
FROM `your_project.your_dataset.your_source_table`
WHERE
  (@app IS NULL OR metadata.app = @app)
  AND (@env IS NULL OR metadata.env = @env)
  AND (@level IS NULL OR metadata.level = @level)
  AND (@event IS NULL OR event_message = @event)
  AND timestamp >= TIMESTAMP(@since)
ORDER BY timestamp DESC
LIMIT @limit
```

> Note: Replace `your_project.your_dataset.your_source_table` with the BigQuery table Logflare shows in the source settings.

4. Save and copy the Endpoint UUID into `LOGFLARE_ENDPOINT_ID` env var (added in Task 1).

---

**Files:**
- Create: `web/api/v1/logflare.js`
- Modify: `web/vercel.json`

The handler proxies GET query params to Logflare's Endpoint API and normalizes the response to match the timber logs response shape so callers get a consistent format.

- [ ] **Step 1: Create `web/api/v1/logflare.js`**

```js
// GET /v1/logflare — proxy search queries to the configured Logflare Endpoint.
// Accepts the same filter params as GET /v1/logs (app, env, level, event, since,
// limit) and returns items in the same shape so clients can switch sources easily.
import { requireRead } from '../_lib/auth.js';
import { json, badRequest, methodNotAllowed } from '../_lib/respond.js';
import { logflareConfig } from '../_lib/env.js';

const LOGFLARE_ENDPOINT = 'https://api.logflare.app/api/endpoints/query';
const INT_RE = /^-?\d+$/;

function parseParams(sp) {
  const limit = sp.get('limit');
  if (limit !== null && !INT_RE.test(limit)) {
    return { ok: false, error: `invalid limit "${limit}"` };
  }
  return {
    ok: true,
    value: {
      app: sp.get('app') ?? null,
      env: sp.get('env') ?? null,
      level: sp.get('level') ?? null,
      event: sp.get('event') ?? null,
      since: sp.get('since') ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      limit: limit ? Math.min(Math.max(Number(limit), 1), 500) : 100,
    },
  };
}

function buildEndpointUrl(endpointId, params) {
  const url = new URL(`${LOGFLARE_ENDPOINT}/${endpointId}`);
  if (params.app) url.searchParams.set('@app', params.app);
  if (params.env) url.searchParams.set('@env', params.env);
  if (params.level) url.searchParams.set('@level', params.level);
  if (params.event) url.searchParams.set('@event', params.event);
  url.searchParams.set('@since', params.since);
  url.searchParams.set('@limit', String(params.limit));
  return url.toString();
}

function normalizeRow(row) {
  const doc = {
    app: row['metadata.app'] ?? row.app ?? '',
    env: row['metadata.env'] ?? row.env ?? '',
    event: row.event_message ?? row.event ?? '',
    level: row['metadata.level'] ?? row.level ?? '',
    receivedAt: row.timestamp ?? row['metadata.receivedAt'] ?? null,
  };
  if (row['metadata.ts']) doc.ts = row['metadata.ts'];
  if (row['metadata.message']) doc.message = row['metadata.message'];
  if (row['metadata.ids']) doc.ids = row['metadata.ids'];
  if (row['metadata.data']) doc.data = row['metadata.data'];
  return doc;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  if (!requireRead(req, res)) return;

  const { endpointId, apiKey } = logflareConfig();
  if (!endpointId || !apiKey) {
    return json(res, 503, { error: 'logflare not configured' });
  }

  const sp = new URL(req.url, 'http://localhost').searchParams;
  const parsed = parseParams(sp);
  if (!parsed.ok) return badRequest(res, parsed.error);

  const url = buildEndpointUrl(endpointId, parsed.value);
  let upstream;
  try {
    upstream = await fetch(url, { headers: { 'X-API-KEY': apiKey } });
  } catch (err) {
    return json(res, 502, { error: 'logflare unreachable' });
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return json(res, 502, { error: 'logflare error', detail: text });
  }

  const body = await upstream.json();
  const items = (body.result ?? []).map(normalizeRow);
  return json(res, 200, { items, nextCursor: null, source: 'logflare' });
}
```

- [ ] **Step 2: Add rewrite to `web/vercel.json`**

Open `web/vercel.json` and add the new route to the `rewrites` array:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    { "source": "/v1/logflare", "destination": "/api/v1/logflare" },
    { "source": "/v1/:path*", "destination": "/api/v1/:path*" },
    { "source": "/healthz", "destination": "/api/healthz" },
    { "source": "/(.*)", "destination": "/index.html" }
  ],
  "crons": [
    { "path": "/api/cron/retention", "schedule": "0 3 * * *" }
  ]
}
```

> The `/v1/logflare` rewrite must come before `/v1/:path*` so it is matched first.

- [ ] **Step 3: Run existing tests to confirm nothing broke**

```bash
cd web && npm test
```

Expected: all existing tests pass (new file has no unit tests here - it's a thin proxy handler with no pure logic to unit test separately).

- [ ] **Step 4: Commit**

```bash
git add web/api/v1/logflare.js web/vercel.json
git commit -m "feat(logflare): GET /v1/logflare endpoint proxying Logflare Endpoints API"
```

---

## Task 5: Deploy and smoke test

- [ ] **Step 1: Deploy to Vercel**

```bash
cd web && vercel --prod
```

- [ ] **Step 2: Verify dual-write is working**

Send a test event (replace URL and key with your values):

```bash
curl -s -X POST https://timber-console.vercel.app/v1/logs \
  -H "Authorization: Bearer YOUR_WRITE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"batch":[{"event":"logflare.test","level":"info","data":{"hello":"world"}}]}'
```

Expected response:
```json
{"accepted":1,"rejected":0}
```

Then check Logflare UI: the event should appear in your source within ~10 seconds.

- [ ] **Step 3: Verify GET /v1/logflare**

```bash
curl -s "https://timber-console.vercel.app/v1/logflare?app=dailyDashboard&level=error&limit=5" \
  -H "Authorization: Bearer YOUR_READ_KEY"
```

Expected response shape:
```json
{
  "items": [
    {
      "app": "dailyDashboard",
      "env": "prod",
      "event": "db.query",
      "level": "error",
      "receivedAt": "2026-06-30T...",
      "data": { "error": "E11000 duplicate key..." }
    }
  ],
  "nextCursor": null,
  "source": "logflare"
}
```

- [ ] **Step 4: Verify Neon insert still works (Neon is still the primary)**

```bash
curl -s "https://timber-console.vercel.app/v1/logs?app=dailyDashboard&limit=1" \
  -H "Authorization: Bearer YOUR_READ_KEY"
```

Should return the event from Step 2 (if within TTL).

---

## Vercel Resource Usage - What to Fix in `dailyDashboard`

The numbers from the Neon logs tell a clear story:

| Source | Events logged | Rate |
|---|---|---|
| `notification_outbox` finds | 126,824 | ~1/sec per worker (3 workers) |
| `perfMetrics` inserts | 18,257 | every 60s |
| `taskBody` finds | 25,619 | on user action |
| `http.request` | 25,995 | per API call |

The `notification_outbox` polling is the killer. It fires 3 times per second (3 worker processes), and each poll is logged as a separate timber event. That is **~9 million events/month** from this one query alone - each one a Vercel function invocation.

**Recommended fix in `dailyDashboard`:** Only log `db.query` events when either:
- `level !== 'info'` (errors always log)
- `durationMs > 500` (slow query threshold)
- `collection` is not a polling collection (exclude `notification_outbox` from routine logging)

This alone would cut Vercel invocations by ~80%.
