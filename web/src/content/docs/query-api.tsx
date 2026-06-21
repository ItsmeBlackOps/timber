import type { DocPage } from "@/content/docs/types";
import { CodeBlock } from "@/components/CodeBlock";
import { Code, H2, H3, LI, Lead, P, Table, UL } from "@/content/docs/_ui";
import { DOCUMENTED_ENDPOINTS } from "@/content/docs/api-surface";

function Body() {
  return (
    <div>
      <Lead>
        All <Code>/v1/*</Code> endpoints are JSON and require{" "}
        <Code>Authorization: Bearer &lt;key&gt;</Code>. <Code>GET /healthz</Code>{" "}
        needs no auth. Unknown query params are rejected with <Code>400</Code>.
      </Lead>

      <H2>Endpoints</H2>
      <Table
        head={["endpoint", "auth", "params", "what it does"]}
        rows={DOCUMENTED_ENDPOINTS.map((e) => [
          <Code key="p">{`${e.method} ${e.path}`}</Code>,
          e.auth ? "key" : "none",
          <span key="q">
            {e.params.length === 0 ? (
              <span style={{ color: "var(--tb-mut)" }}>—</span>
            ) : (
              e.params.map((p, i) => (
                <span key={p}>
                  {i > 0 ? " " : ""}
                  <Code>{p}</Code>
                </span>
              ))
            )}
          </span>,
          e.summary,
        ])}
      />

      <H2>
        <Code>GET /v1/logs</Code> — search
      </H2>
      <P>
        Returns <Code>{`{items:[…], nextCursor:"…"|null}`}</Code>, newest-first
        (<Code>receivedAt</Code> desc). Default <Code>limit</Code> 100, max 500.
      </P>
      <Table
        head={["param", "meaning"]}
        rows={[
          [<Code key="p">app</Code>, "exact app match"],
          [<Code key="p">env</Code>, "exact env match"],
          [
            <Code key="p">level</Code>,
            <span key="m">
              csv of <Code>debug,info,warn,error</Code>
            </span>,
          ],
          [
            <Code key="p">event</Code>,
            <span key="m">
              <strong>prefix</strong> match (<Code>event=ai.</Code> matches{" "}
              <Code>ai.request</Code>)
            </span>,
          ],
          [
            <Code key="p">from</Code>,
            <span key="m">
              <Code>receivedAt</Code> ≥ — ISO-8601 or epoch-ms (inclusive)
            </span>,
          ],
          [
            <Code key="p">to</Code>,
            <span key="m">
              <Code>receivedAt</Code> &lt; — ISO-8601 or epoch-ms (exclusive)
            </span>,
          ],
          [
            <Code key="p">ids.&lt;key&gt;</Code>,
            "exact correlation-id match (e.g. ids.taskId=…)",
          ],
          [
            <Code key="p">data.&lt;path&gt;</Code>,
            "exact match on a nested data path (numeric/boolean match number or string)",
          ],
          [
            <span key="p">
              <Code>data.&lt;path&gt;__gte</Code>,{" "}
              <Code>data.&lt;path&gt;__lte</Code>
            </span>,
            "numeric range (combinable on one path)",
          ],
          [
            <Code key="p">q</Code>,
            "case-insensitive regex over message, ≤ 256 chars (nested-quantifier patterns rejected — ReDoS guard)",
          ],
          [<Code key="p">limit</Code>, "1..500, default 100"],
          [
            <Code key="p">cursor</Code>,
            <span key="m">
              opaque <Code>nextCursor</Code> from the previous page
            </span>,
          ],
        ]}
      />
      <CodeBlock
        lang="bash"
        code={`# AI calls slower than 30s in the last 24h
curl -s "$TIMBER_URL/v1/logs?event=ai.&data.latencyMs__gte=30000" \\
  -H "Authorization: Bearer $TIMBER_KEY"`}
      />

      <H3>Cursor pagination</H3>
      <P>
        <Code>nextCursor</Code> is opaque and URL-safe — pass it back verbatim;{" "}
        <Code>null</Code> means the last page.
      </P>
      <CodeBlock
        lang="bash"
        code={`CURSOR=""
while :; do
  URL="$TIMBER_URL/v1/logs?app=scraper&limit=500"
  [ -n "$CURSOR" ] && URL="$URL&cursor=$CURSOR"
  PAGE=$(curl -s "$URL" -H "Authorization: Bearer $TIMBER_KEY")
  echo "$PAGE" | jq -c '.items[]'
  CURSOR=$(echo "$PAGE" | jq -r '.nextCursor // empty')
  [ -z "$CURSOR" ] && break
done`}
      />

      <H2>
        <Code>GET /v1/stats</Code> — rollups
      </H2>
      <P>
        Time-bucketed metrics. Params: <Code>group=hour|day</Code> (default{" "}
        <Code>hour</Code>), <Code>from</Code>/<Code>to</Code> (default last 24h),{" "}
        <Code>app</Code> (exact), <Code>event</Code> (prefix). Each bucket carries{" "}
        <Code>total</Code>, per-level <Code>counts</Code>, <Code>latency</Code>{" "}
        (p50/p95/p99 or <Code>null</Code>), <Code>errorRate</Code> (or{" "}
        <Code>null</Code>), <Code>costUsd</Code>, <Code>inputTokens</Code>,{" "}
        <Code>outputTokens</Code>.
      </P>
      <CodeBlock
        lang="bash"
        code={`curl -s "$TIMBER_URL/v1/stats?group=hour&event=ai.&from=2026-06-10T00:00:00Z" \\
  -H "Authorization: Bearer $TIMBER_KEY"`}
      />

      <H2>
        <Code>GET /v1/events</Code> — taxonomy
      </H2>
      <P>
        Distinct event names per app: <Code>{`{apps:{<app>:[…]}}`}</Code>. Param:{" "}
        <Code>app</Code> (exact) to scope to one.
      </P>

      <H2>
        <Code>GET /v1/facets</Code> — discover fields
      </H2>
      <P>
        Which <Code>ids.&lt;key&gt;</Code> and <Code>data.&lt;path&gt;</Code>{" "}
        keys occur in a window. Params: <Code>app</Code>, <Code>from</Code>,{" "}
        <Code>to</Code> (default last 24h). Returns{" "}
        <Code>{`{window, idsKeys[], dataPaths[]}`}</Code>, sorted.
      </P>

      <H2>
        <Code>GET /v1/groupby</Code> — count by field
      </H2>
      <P>
        Counts documents grouped by one field, over the same filter surface as{" "}
        <Code>/v1/logs</Code>. Returns the top groups plus an{" "}
        <Code>otherCount</Code> rollup of the tail.
      </P>
      <UL>
        <LI>
          <Code>by</Code> (<strong>required</strong>): <Code>app</Code>,{" "}
          <Code>env</Code>, <Code>level</Code>, <Code>event</Code>, or any{" "}
          <Code>ids.&lt;key&gt;</Code> / <Code>data.&lt;path&gt;</Code>. Anything
          else (incl. <Code>$</Code>-injection) ⇒ <Code>400</Code>.
        </LI>
        <LI>
          <Code>limit</Code>: number of groups, 1..100, default 20 (the rest fold
          into <Code>otherCount</Code>).
        </LI>
        <LI>
          <Code>like</Code>: case-insensitive substring on the grouped{" "}
          <em>values</em> (value autocomplete), ≤ 128 chars.
        </LI>
        <LI>
          Plus every <Code>/v1/logs</Code> filter (<Code>app</Code>,{" "}
          <Code>env</Code>, <Code>level</Code>, <Code>event</Code>,{" "}
          <Code>from</Code>/<Code>to</Code>, <Code>q</Code>,{" "}
          <Code>ids.&lt;key&gt;</Code>, <Code>data.&lt;path&gt;</Code> +{" "}
          <Code>__gte</Code>/<Code>__lte</Code>). <Code>cursor</Code> is not
          accepted.
        </LI>
      </UL>
      <CodeBlock
        lang="bash"
        code={`# which users hit the most errors in the last 24h
curl -s "$TIMBER_URL/v1/groupby?by=ids.userEmail&level=error" \\
  -H "Authorization: Bearer $TIMBER_KEY"`}
      />

      <H2>
        <Code>GET /healthz</Code> — liveness
      </H2>
      <P>
        No auth. Returns <Code>ok</Code> plus <Code>wal</Code> (totalBytes,
        backlogBytes, overBudget), <Code>flusher</Code> (running, caughtUp,
        flushedTotal, lastError) and <Code>mongo</Code> (connected). The health
        dot in the top bar reads this.
      </P>

      <H2>Status codes</H2>
      <Table
        head={["status", "meaning"]}
        rows={[
          [<Code key="s">200</Code>, "OK (queries, healthz)"],
          [
            <Code key="s">400</Code>,
            "bad query param / invalid value (unknown params are rejected)",
          ],
          [<Code key="s">401</Code>, "unknown or missing key"],
          [
            <Code key="s">503</Code>,
            "storage unavailable — MongoDB unreachable (reads only; ingest is unaffected)",
          ],
        ]}
      />
    </div>
  );
}

export const queryApi: DocPage = {
  slug: "query-api",
  title: "Query API reference",
  blurb:
    "Every read endpoint, its params, examples, cursor pagination, and status codes.",
  Body,
};
