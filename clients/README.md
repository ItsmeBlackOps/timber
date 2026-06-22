# Timber log clients

Tiny, dependency-free helpers that POST batched logs to a Vercel-hosted Timber.
Any HTTP client works (the service is plain REST); these just add the batching,
the heartbeat filter, and a level gate so an app never floods the service.

## Endpoint

```
POST ${TIMBER_URL}/v1/logs
Authorization: Bearer <write key>
Content-Type: application/json

# one event or an array (batch up to 500):
{ "event": "user.signup", "level": "info", "message": "new user",
  "ids": { "userId": "u1", "requestId": "r9" },
  "data": { "latencyMs": 42, "status": 200 } }
```

`event` is required. `level` is one of `debug|info|warn|error` (default `info`).
`ids` and `data` are free-form objects. The response is `201 {"accepted":N}`.

## Conventions the lenses rely on

- AI Usage: put `model`, `inputTokens`, `outputTokens`, `costUsd` in `data`.
- Slow Operations / latency: put `latencyMs` (or `durationMs`) in `data`.
- HTTP error rate: put `status` in `data` (>= 400 counts as an error).
- By User: put the user id in `ids.userId` (or `data.userId`).
- Cron and Jobs: name job events with a `cron.` prefix, e.g. `cron.nightly-sync`,
  and put `status` (`ok`/`error`) and `latencyMs` in `data`.

## Environment

| Var | Meaning |
|-----|---------|
| `TIMBER_URL` | e.g. `https://your-app.vercel.app` |
| `TIMBER_WRITE_KEY` | a write-mode key from the service's `TIMBER_KEYS` |
| `LOG_MIN_LEVEL` | drop anything below this level (default `info`) |

## Python (firehook, intervue)

Copy `timber_client.py` next to your app, then:

```python
from timber_client import log, flush

log("consumer.start", level="info", message="worker up")
log("ai.call", data={"model": "claude", "inputTokens": 800,
                     "outputTokens": 120, "costUsd": 0.004, "latencyMs": 950})
# a background thread flushes every couple of seconds; flush() on shutdown.
flush()
```

The client drops the old firehook heartbeat (`No message (still listening)`,
the hourglass, anything matching `heartbeat`) before it ever leaves the process,
so the heartbeat-flood CPU spike cannot recur.

## Node (auto-assign)

```js
import { createTimberClient } from './timber-client.js';
const timber = createTimberClient(); // reads TIMBER_URL / TIMBER_WRITE_KEY

timber.log('assign.run', { level: 'info', message: 'batch start', ids: { requestId: 'r1' } });
timber.log('cron.nightly-sync', { data: { status: 'ok', latencyMs: 1200 } });
// timer flushes automatically; await timber.close() on shutdown.
```

## Viewing logs

Open the Console (the same Vercel URL), set a read-mode key in Settings, and use
Explore, Stats, and the per-project lenses. Or query directly:

```
GET ${TIMBER_URL}/v1/logs?level=error&limit=50
Authorization: Bearer <read key>
```
