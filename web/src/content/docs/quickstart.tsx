import type { DocPage } from "@/content/docs/types";
import { CodeBlock } from "@/components/CodeBlock";
import { Code, H2, LI, Lead, P, UL } from "@/content/docs/_ui";

function Body() {
  return (
    <div>
      <Lead>
        Three steps: get a key, send your first event, then find it here. About
        two minutes.
      </Lead>

      <H2>1. Get a key</H2>
      <P>
        Keys live in Timber's environment (<Code>TIMBER_KEYS</Code>), never in
        your app. Ask whoever runs Timber for a key — a <strong>write</strong>{" "}
        key to send events, or a <strong>read</strong> key for this Console.
        Then set two shell vars:
      </P>
      <CodeBlock
        lang="bash"
        code={`export TIMBER_URL=http://localhost:7710
export TIMBER_KEY=w-yourapp-prod-CHANGE_ME   # a write key from TIMBER_KEYS`}
      />

      <H2>2. Send your first log</H2>
      <P>
        Only <Code>event</Code> is required. The server stamps <Code>app</Code>,{" "}
        <Code>env</Code> (from your key), <Code>receivedAt</Code> and an{" "}
        <Code>_id</Code>.
      </P>
      <CodeBlock
        lang="bash"
        code={`curl -i -X POST "$TIMBER_URL/v1/logs" \\
  -H "Authorization: Bearer $TIMBER_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"event":"cron.run","data":{"job":"nightlyReport","scanned":412,"durationMs":8120}}'`}
      />
      <P>
        A <Code>202 {`{"accepted":1}`}</Code> means the event is durably in the
        write-ahead log — it survives a crash or a Mongo outage, and the flusher
        moves it into Mongo within moments.
      </P>

      <H2>3. View it</H2>
      <P>Open this Console, paste a read key in Settings, then:</P>
      <UL>
        <LI>
          Go to <strong>Explore</strong> and search <Code>event=cron.</Code> (a
          prefix match) — your event appears newest-first.
        </LI>
        <LI>Click the row to expand the full JSON in the detail panel.</LI>
        <LI>
          Or from the command line:{" "}
          <Code>{`curl -s "$TIMBER_URL/v1/logs?event=cron." -H "Authorization: Bearer $TIMBER_KEY"`}</Code>
        </LI>
      </UL>

      <P>
        That's the whole loop. Next, learn the{" "}
        <strong>event contract</strong> to structure events well, or jump to{" "}
        <strong>Sending logs</strong> for Node and Python helpers.
      </P>
    </div>
  );
}

export const quickstart: DocPage = {
  slug: "quickstart",
  title: "Quickstart",
  blurb: "Get a key, send your first log, and view it — in two minutes.",
  Body,
};
