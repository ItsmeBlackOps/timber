import type { StatsResponse } from "@/lib/types";

export interface MetricCardsProps {
  /** Latest /v1/stats payload, or undefined while loading. */
  stats: StatsResponse | undefined;
}

interface Metric {
  id: string;
  label: string;
  value: string;
  /** Accent color (CSS var) for the value, e.g. error rate uses the error color. */
  accent?: string;
}

const EM_DASH = "—";

const intFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** Round to 1 decimal and drop a trailing ".0" so "1.50" -> "1.5", "0" -> "0". */
function fmtPercent(n: number): string {
  if (!Number.isFinite(n)) return `0%`;
  const r = Math.round(n * 10) / 10;
  return `${r}%`;
}

/** Money: 2 dp for >= $0.01, otherwise up to 4 dp so sub-cent costs stay visible. */
function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  const abs = Math.abs(n);
  const digits = abs !== 0 && abs < 0.01 ? 4 : 2;
  return `$${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  })}`;
}

/**
 * Derive the headline metrics from the bucket series. p95 is "representative":
 * the peak p95 across buckets that actually recorded latency (null buckets are
 * ignored, never counted as zero), which is the number an operator cares about.
 */
function deriveMetrics(stats: StatsResponse | undefined): Metric[] {
  const buckets = stats?.buckets ?? [];

  let totalEvents = 0;
  let totalErrors = 0;
  let totalCost = 0;
  let totalTokens = 0;
  let peakP95: number | null = null;

  for (const b of buckets) {
    totalEvents += b.total;
    totalErrors += b.counts.error;
    totalCost += b.costUsd;
    totalTokens += b.inputTokens + b.outputTokens;
    if (b.latency) {
      peakP95 = peakP95 === null ? b.latency.p95 : Math.max(peakP95, b.latency.p95);
    }
  }

  const errorRate = totalEvents > 0 ? (totalErrors / totalEvents) * 100 : 0;

  return [
    { id: "total", label: "Total events", value: intFmt.format(totalEvents) },
    {
      id: "errorRate",
      label: "Error rate",
      value: fmtPercent(errorRate),
      accent: totalErrors > 0 ? "var(--tb-error)" : undefined,
    },
    { id: "cost", label: "AI cost", value: fmtUsd(totalCost) },
    {
      id: "p95",
      label: "p95 latency",
      value: peakP95 === null ? EM_DASH : `${Math.round(peakP95)} ms`,
    },
    { id: "tokens", label: "Total tokens", value: intFmt.format(totalTokens) },
  ];
}

/**
 * Stats headline cards (contract C-F9): total events, error rate %, Σ AI cost,
 * representative p95 latency, and Σ tokens — derived from a StatsResponse.
 * Displayed numbers are rounded; null latency buckets are excluded, not zeroed.
 */
export function MetricCards({ stats }: MetricCardsProps) {
  const metrics = deriveMetrics(stats);
  return (
    <div
      role="list"
      aria-label="Summary metrics"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        gap: 12,
      }}
    >
      {metrics.map((m) => (
        <div
          key={m.id}
          role="listitem"
          data-metric={m.id}
          data-testid={`metric-${m.id}`}
          style={{
            background: "var(--tb-surface)",
            border: "1px solid var(--tb-border)",
            borderRadius: 8,
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: "var(--tb-mut)",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            {m.label}
          </span>
          <span
            data-testid="metric-value"
            style={{
              fontSize: 24,
              fontWeight: 600,
              color: m.accent ?? "var(--tb-text)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {m.value}
          </span>
        </div>
      ))}
    </div>
  );
}
