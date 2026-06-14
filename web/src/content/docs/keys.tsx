import type { DocPage } from "@/content/docs/types";
import { CodeBlock } from "@/components/CodeBlock";
import { Code, H2, LI, Lead, P, Table, UL } from "@/content/docs/_ui";

function Body() {
  return (
    <div>
      <Lead>
        Keys live only in Timber's environment (<Code>TIMBER_KEYS</Code>, a JSON
        array) — never in app code or commits. There are two modes.
      </Lead>

      <H2>Read vs write</H2>
      <Table
        head={["mode", "can do", "scope"]}
        rows={[
          [
            <Code key="m">write</Code>,
            <span key="c">
              ingest (<Code>POST /v1/logs</Code>) <strong>and</strong> query
            </span>,
            <span key="s">
              the key's <Code>app</Code>/<Code>env</Code> are stamped on every
              event it sends (body can't override)
            </span>,
          ],
          [
            <Code key="m">read</Code>,
            <span key="c">
              query only (a read key on <Code>POST</Code> ⇒ <Code>403</Code>)
            </span>,
            <span key="s">
              sees <strong>all</strong> apps — this is a single-org tool;{" "}
              <Code>app</Code>/<Code>env</Code> are just labels
            </span>,
          ],
        ]}
      />
      <P>
        Unknown or missing key ⇒ <Code>401</Code> on every <Code>/v1/*</Code>{" "}
        request.
      </P>
      <CodeBlock
        lang="json"
        code={`export TIMBER_KEYS='[
  {"key":"w-dailyDashboard-prod-CHANGE_ME","app":"dailyDashboard","env":"prod","mode":"write"},
  {"key":"r-assistant-CHANGE_ME","app":"assistant","env":"prod","mode":"read"}
]'`}
      />

      <H2>Rotation</H2>
      <P>
        Edit <Code>TIMBER_KEYS</Code> and restart the Timber process. Keys never
        appear in log output, so a leaked key is contained by rotation. There is
        no per-key revocation list beyond the env array.
      </P>

      <H2>Sharing the read key with an AI assistant</H2>
      <P>
        A read key lets an assistant answer "what happened?" during a debugging
        session without SSH or database access. It can read every app's logs but
        cannot write, and grants no access to the VM, the WAL files, or MongoDB
        itself.
      </P>
      <UL>
        <LI>Hand it over out-of-band; never commit it.</LI>
        <LI>
          Remember the key can see whatever is in <Code>data</Code> — keep
          secrets out via transport redaction, and log IDs, not payloads.
        </LI>
        <LI>
          Point the assistant at <Code>/v1/logs</Code>, <Code>/v1/stats</Code>{" "}
          and <Code>/v1/events</Code> with a base URL and the key:
        </LI>
      </UL>
      <CodeBlock
        lang="bash"
        code={`export TIMBER_URL=https://timber.internal.example.com
export TIMBER_KEY=r-assistant-CHANGE_ME

# what's breaking right now?
curl -s "$TIMBER_URL/v1/logs?level=error&from=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)" \\
  -H "Authorization: Bearer $TIMBER_KEY"

# follow one request across apps
curl -s "$TIMBER_URL/v1/logs?ids.requestId=req-8f31" -H "Authorization: Bearer $TIMBER_KEY"`}
      />
      <P>
        In this Console, the read key is stored in your browser's localStorage
        (Settings) and sent as a <Code>Bearer</Code> token — it never leaves your
        machine except to the API you point it at.
      </P>
    </div>
  );
}

export const keys: DocPage = {
  slug: "keys",
  title: "Keys & access",
  blurb: "Read vs write keys, rotation, and sharing a read key with an AI assistant.",
  Body,
};
