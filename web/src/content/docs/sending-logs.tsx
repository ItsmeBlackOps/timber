import type { DocPage } from "@/content/docs/types";
import { CodeBlock } from "@/components/CodeBlock";
import { Code, H2, LI, Lead, P, UL } from "@/content/docs/_ui";

function Body() {
  return (
    <div>
      <Lead>
        Transports live in your app, not in Timber. The golden rule: logging to
        Timber is <strong>additive</strong> — keep writing to stdout as you do
        today, and never let your app fail because the log service is down.
      </Lead>

      <H2>Transport rules</H2>
      <UL>
        <LI>
          <strong>Never throw, never block</strong> a request on a log send.
        </LI>
        <LI>
          <strong>Buffer in memory</strong> (cap ~5k events, drop-oldest with a{" "}
          <Code>transport.dropped</Code> counter), <strong>batch</strong> every
          ~2 s or 100 events into one <Code>POST</Code>.
        </LI>
        <LI>
          <strong>Back off</strong> on <Code>429</Code> (respect{" "}
          <Code>Retry-After</Code>) and on network errors; fall back silently to
          stdout if Timber is unreachable.
        </LI>
        <LI>
          <strong>Redact</strong> secret-looking values before sending; send IDs,
          not payloads.
        </LI>
      </UL>

      <H2>curl</H2>
      <P>One event, or an array of up to 500:</P>
      <CodeBlock
        lang="bash"
        code={`curl -s -X POST "$TIMBER_URL/v1/logs" \\
  -H "Authorization: Bearer $TIMBER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '[
    {"event":"ai.request","ids":{"taskId":"6a2877f0"},
     "data":{"model":"claude-opus-4-8","inputTokens":9120,"outputTokens":2330,
             "latencyMs":41200,"status":200,"costUsd":0.31}},
    {"event":"db.query","level":"warn","message":"slow visibility query",
     "data":{"collection":"taskBody","operation":"aggregate","latencyMs":2773}}
  ]'`}
      />

      <H2>Node — batching tap</H2>
      <P>
        A tiny client that buffers and flushes on an interval, never throwing.
        Wire it behind your existing logger so everything also goes to Timber.
      </P>
      <CodeBlock
        lang="js"
        code={`// timber.js — additive, fire-and-forget transport
const URL = process.env.TIMBER_URL, KEY = process.env.TIMBER_KEY;
const buf = []; const CAP = 5000;
let dropped = 0;

export function logEvent(ev) {
  if (buf.length >= CAP) { buf.shift(); dropped++; }
  buf.push(ev);
}

async function flush() {
  if (dropped) { buf.push({ event: "transport.dropped", data: { count: dropped } }); dropped = 0; }
  if (!buf.length || !URL || !KEY) return;
  const batch = buf.splice(0, 100);
  try {
    const res = await fetch(URL + "/v1/logs", {
      method: "POST",
      headers: { "Authorization": "Bearer " + KEY, "Content-Type": "application/json" },
      body: JSON.stringify(batch),
    });
    if (res.status === 429) {                       // WAL budget — re-buffer + back off
      buf.unshift(...batch);
      await new Promise(r => setTimeout(r, Number(res.headers.get("Retry-After") || 5) * 1000));
    }
  } catch {
    buf.unshift(...batch);                          // network down — keep for next tick (stdout still has it)
  }
}
setInterval(() => { flush().catch(() => {}); }, 2000).unref();`}
      />

      <H2>Node — ai.request wrapper</H2>
      <P>
        Wrap your model calls to emit a consistent <Code>ai.request</Code> event
        with the cost/token conventions, so Stats and the AI-usage lens light up.
      </P>
      <CodeBlock
        lang="js"
        code={`import { logEvent } from "./timber.js";

export async function aiRequestLog(fn, { model, taskId }) {
  const started = Date.now();
  try {
    const out = await fn();                         // out: { text, usage, costUsd }
    logEvent({
      event: "ai.request",
      ids: { taskId },
      data: {
        model,
        inputTokens: out.usage?.inputTokens,
        outputTokens: out.usage?.outputTokens,
        costUsd: out.costUsd,
        latencyMs: Date.now() - started,
        status: 200,
      },
    });
    return out;
  } catch (err) {
    logEvent({ event: "ai.request", level: "error", ids: { taskId },
      data: { model, latencyMs: Date.now() - started, status: 500, error: String(err) } });
    throw err;                                       // wrapper logs, but never swallows your error
  }
}`}
      />

      <H2>Python — logging.Handler</H2>
      <P>
        A ~60-line handler with the same batching/backoff semantics, so{" "}
        <Code>logging.info(...)</Code> also reaches Timber.
      </P>
      <CodeBlock
        lang="python"
        code={`import json, os, threading, time, urllib.request, logging

class TimberHandler(logging.Handler):
    def __init__(self, url=None, key=None, cap=5000, flush_s=2.0):
        super().__init__()
        self.url = url or os.environ["TIMBER_URL"]
        self.key = key or os.environ["TIMBER_KEY"]
        self.buf, self.lock, self.cap = [], threading.Lock(), cap
        t = threading.Thread(target=self._loop, args=(flush_s,), daemon=True)
        t.start()

    def emit(self, record):
        ev = {"event": record.name, "level": record.levelname.lower(),
              "message": record.getMessage(), "data": getattr(record, "data", {})}
        with self.lock:
            if len(self.buf) >= self.cap:
                self.buf.pop(0)
            self.buf.append(ev)

    def _loop(self, flush_s):
        while True:
            time.sleep(flush_s)
            with self.lock:
                batch, self.buf = self.buf[:100], self.buf[100:]
            if not batch:
                continue
            try:
                req = urllib.request.Request(
                    self.url + "/v1/logs", data=json.dumps(batch).encode(),
                    headers={"Authorization": "Bearer " + self.key,
                             "Content-Type": "application/json"}, method="POST")
                urllib.request.urlopen(req, timeout=5)
            except Exception:
                with self.lock:                       # never raise from logging; keep for next tick
                    self.buf[:0] = batch`}
      />
      <P>
        Levels map to retention TTLs, so use them deliberately:{" "}
        <Code>debug</Code> for chatter, <Code>error</Code> for things you'll want
        kept longest.
      </P>
    </div>
  );
}

export const sendingLogs: DocPage = {
  slug: "sending-logs",
  title: "Sending logs",
  blurb: "curl, a Node tap + ai.request wrapper, and a Python logging.Handler.",
  Body,
};
