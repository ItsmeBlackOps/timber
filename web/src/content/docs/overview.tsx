import type { DocPage } from "@/content/docs/types";
import { Code, H2, LI, Lead, P, UL } from "@/content/docs/_ui";

function Body() {
  return (
    <div>
      <Lead>
        Timber is a small, framework-free central log service. Apps and services
        ship structured events to it; this Console is the read-side window onto
        those events — search, faceted finding, live tail, stats, and these docs.
      </Lead>

      <H2>What it is</H2>
      <P>
        One endpoint to ingest events (<Code>POST /v1/logs</Code>) and a handful
        of read endpoints to query them. Events are a generic envelope — an{" "}
        <Code>event</Code> name plus optional <Code>level</Code>,{" "}
        <Code>ids</Code> (correlation keys) and <Code>data</Code> (arbitrary
        JSON). Timber is taxonomy-agnostic: your services define what events
        mean.
      </P>

      <H2>WAL-first durability</H2>
      <P>
        Ingest is durable before it is queryable. Every accepted batch is written
        to a write-ahead log and fsync'd before the <Code>202</Code> returns, so
        events survive a Timber crash or a MongoDB outage. A background flusher
        drains the WAL into MongoDB, which backs all the read endpoints.
      </P>
      <UL>
        <LI>
          <strong>Write path</strong>: <Code>POST /v1/logs</Code> → validate →
          append to WAL → fsync → <Code>202 {`{accepted:n}`}</Code>. Mongo being
          down never blocks ingest.
        </LI>
        <LI>
          <strong>Flusher</strong>: replays + tails the WAL into Mongo with
          retry/backoff; old segments are retained then deleted by a janitor.
        </LI>
        <LI>
          <strong>Read path</strong>: this Console (and curl) query Mongo via the{" "}
          <Code>/v1/*</Code> read endpoints. While Mongo is unreachable, reads
          answer <Code>503</Code> — ingest keeps working.
        </LI>
      </UL>

      <H2>Guarantees & limits</H2>
      <UL>
        <LI>
          A <Code>202</Code> means durably persisted, not yet necessarily in
          Mongo (sub-second under normal flusher lag).
        </LI>
        <LI>
          Events carry <em>IDs, not payloads</em> — log a <Code>taskId</Code>,
          not a transcript. Oversize <Code>data</Code> is truncated, not
          rejected.
        </LI>
        <LI>
          Retention is per-level via TTL (debug shortest, warn/error longest).
        </LI>
        <LI>
          A single read key sees <em>all</em> apps (this is a one-org internal
          tool). Per-key app scoping is a non-goal for v1.
        </LI>
      </UL>

      <H2>Using this Console</H2>
      <P>
        Paste a read key under <strong>Settings</strong>, then use{" "}
        <strong>Explore</strong> to search and pivot, <strong>Stats</strong> for
        rollups (including AI cost and tokens), and the rest of these{" "}
        <strong>Docs</strong> to learn the event contract and query API. All
        filter state lives in the URL, so any view you build is a shareable link.
      </P>
    </div>
  );
}

export const overview: DocPage = {
  slug: "overview",
  title: "Overview",
  blurb: "What Timber is and how the WAL→Mongo architecture guarantees durability.",
  Body,
};
