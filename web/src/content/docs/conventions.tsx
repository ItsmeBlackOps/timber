import type { DocPage } from "@/content/docs/types";
import { Code, H2, Lead, P, Table } from "@/content/docs/_ui";

function Body() {
  return (
    <div>
      <Lead>
        These <Code>data</Code> keys are optional, but when present they power the
        Stats rollups and lenses automatically. Absent keys never break a
        bucket — they just don't contribute.
      </Lead>

      <H2>Recognized data conventions</H2>
      <Table
        head={["key", "type", "what it powers"]}
        rows={[
          [
            <Code key="k">data.latencyMs</Code>,
            "number (ms)",
            "Latency percentiles (p50/p95/p99) on Stats; the Slow-operations lens.",
          ],
          [
            <Code key="k">data.durationMs</Code>,
            "number (ms)",
            <span key="v">
              Fallback for latency when <Code>latencyMs</Code> is absent (jobs,
              cron).
            </span>,
          ],
          [
            <Code key="k">data.status</Code>,
            "number",
            <span key="v">
              Error rate — a value <Code>≥ 400</Code> counts as an error in the
              bucket.
            </span>,
          ],
          [
            <Code key="k">data.costUsd</Code>,
            "number (USD)",
            "Summed into AI-cost totals + the cost-over-time chart.",
          ],
          [
            <Code key="k">data.inputTokens</Code>,
            "number",
            "Summed into total input tokens (tokens chart).",
          ],
          [
            <Code key="k">data.outputTokens</Code>,
            "number",
            "Summed into total output tokens (tokens chart).",
          ],
        ]}
      />

      <H2>How they roll up</H2>
      <P>
        On <Code>/v1/stats</Code>, each time bucket computes{" "}
        <Code>latency</Code> as percentiles over <Code>latencyMs</Code> (falling
        back to <Code>durationMs</Code>), and reports <Code>null</Code> when no
        event in the bucket carried either — the chart shows a gap, not a zero.
        Likewise <Code>errorRate</Code> is the share of <Code>status ≥ 400</Code>{" "}
        among events that carried a <Code>status</Code>, and is <Code>null</Code>{" "}
        when none did. <Code>costUsd</Code> and the token fields are plain sums.
      </P>

      <H2>Naming tips</H2>
      <P>
        Use a consistent event prefix per domain (<Code>ai.</Code>,{" "}
        <Code>db.</Code>, <Code>cron.</Code>, <Code>scrape.</Code>) so prefix
        filters and lenses line up. Keep <Code>model</Code>,{" "}
        <Code>provider</Code>, <Code>collection</Code>, <Code>operation</Code>{" "}
        and similar dimensions in <Code>data</Code> so you can group by them with{" "}
        <Code>/v1/groupby</Code>.
      </P>
    </div>
  );
}

export const conventions: DocPage = {
  slug: "conventions",
  title: "Conventions",
  blurb: "latencyMs / durationMs, status, costUsd, tokens — what each powers.",
  Body,
};
