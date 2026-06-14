import type { DocPage } from "@/content/docs/types";
import { CodeBlock } from "@/components/CodeBlock";
import { Code, H2, LI, Lead, P, Table, UL } from "@/content/docs/_ui";

function Body() {
  return (
    <div>
      <Lead>
        Every event is one JSON envelope. Only <Code>event</Code> is required;
        everything else is optional but conventional. Any unknown top-level key
        rejects the whole batch with <Code>400</Code>.
      </Lead>

      <H2>The envelope</H2>
      <Table
        head={["field", "rules"]}
        rows={[
          [
            <Code key="e">event</Code>,
            <span key="r">
              <strong>required</strong> string, ≤ 200 chars, no control chars.
              Your taxonomy: <Code>ai.request</Code>, <Code>db.query</Code>,{" "}
              <Code>cron.run</Code>, …
            </span>,
          ],
          [
            <Code key="l">level</Code>,
            <span key="r">
              <Code>debug</Code> | <Code>info</Code> | <Code>warn</Code> |{" "}
              <Code>error</Code>, default <Code>info</Code>. Drives retention
              (TTL).
            </span>,
          ],
          [
            <Code key="t">ts</Code>,
            <span key="r">
              optional sender timestamp, must be <Code>Date.parse</Code>-able.
              The server always stamps its own <Code>receivedAt</Code>.
            </span>,
          ],
          [
            <Code key="m">message</Code>,
            <span key="r">optional string; silently truncated to 512 chars.</span>,
          ],
          [
            <Code key="i">ids</Code>,
            <span key="r">
              optional object, ≤ 10 keys; values string/number/boolean (coerced
              to strings). Correlation ids: <Code>requestId</Code>,{" "}
              <Code>taskId</Code>, <Code>userEmail</Code>, …
            </span>,
          ],
          [
            <Code key="d">data</Code>,
            <span key="r">
              optional object, any JSON, ≤ 16 KB serialized. Oversize is stored
              as <Code>{`{_truncated:true, _originalBytes:n, _head:"…"}`}</Code>.
            </span>,
          ],
        ]}
      />
      <P>
        The server adds <Code>app</Code>, <Code>env</Code> (from the key),{" "}
        <Code>receivedAt</Code>, <Code>expiresAt</Code> (per-level TTL) and{" "}
        <Code>_id</Code>. A write key's <Code>app</Code>/<Code>env</Code> can
        never be overridden by the body.
      </P>

      <H2>Example</H2>
      <CodeBlock
        lang="json"
        code={`{
  "event": "ai.request",
  "level": "info",
  "ids": { "taskId": "6a2877f0", "userEmail": "alice@example.com" },
  "data": {
    "provider": "opusmax", "model": "claude-opus-4-8",
    "inputTokens": 9120, "outputTokens": 2330,
    "latencyMs": 41200, "status": 200, "costUsd": 0.31
  }
}`}
      />

      <H2>IDs, not payloads</H2>
      <P>
        <Code>ids</Code> are for <em>correlation</em> — small, high-cardinality
        keys you'll filter and group by. <Code>data</Code> is for{" "}
        <em>structured facts</em> about the event. Do not put large or sensitive
        blobs anywhere:
      </P>
      <UL>
        <LI>
          Log a <Code>taskId</Code>, not the prompt/transcript; a{" "}
          <Code>resumeId</Code>, not the résumé text.
        </LI>
        <LI>
          Redact secrets <em>at the transport</em> before sending — a read key is
          shared broadly (including with AI assistants), so anything in{" "}
          <Code>data</Code> is visible to it.
        </LI>
        <LI>
          Oversize <Code>data</Code> is truncated to a head + byte count, never
          dropped — but multi-MB content should be referenced by ID, not sent.
        </LI>
      </UL>
    </div>
  );
}

export const eventContract: DocPage = {
  slug: "event-contract",
  title: "Event contract",
  blurb: "The envelope: event, level, ids, data, size rules, redaction.",
  Body,
};
