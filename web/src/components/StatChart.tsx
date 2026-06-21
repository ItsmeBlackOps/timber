import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Level, StatsBucket } from "@/lib/types";

export type StatChartKind = "volume" | "errorRate" | "cost" | "tokens" | "latency";

export interface StatChartProps {
  buckets: StatsBucket[];
  kind: StatChartKind;
  /** Fixed pixel width; omit for a responsive (100%) chart. Tests pass an explicit size. */
  width?: number;
  /** Pixel height (default 240). */
  height?: number;
}

const LEVELS: Level[] = ["debug", "info", "warn", "error"];

const LEVEL_COLOR: Record<Level, string> = {
  debug: "var(--tb-debug)",
  info: "var(--tb-info)",
  warn: "var(--tb-warn)",
  error: "var(--tb-error)",
};

const TITLE: Record<StatChartKind, string> = {
  volume: "Event volume by level",
  errorRate: "Error rate",
  cost: "AI cost",
  tokens: "Token usage",
  latency: "Latency percentiles",
};

const SERIES: Record<StatChartKind, string[]> = {
  volume: LEVELS,
  errorRate: ["errorRate"],
  cost: ["costUsd", "cumCostUsd"],
  tokens: ["inputTokens", "outputTokens"],
  latency: ["p50", "p95", "p99"],
};

/** Flattened, chart-friendly row. null latency/errorRate stay null so they render as gaps. */
interface Row {
  bucket: string;
  debug: number;
  info: number;
  warn: number;
  error: number;
  errorRate: number | null;
  costUsd: number;
  cumCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

function toRows(buckets: StatsBucket[]): Row[] {
  let cum = 0;
  return buckets.map((b) => {
    cum += b.costUsd;
    return {
      bucket: b.bucket,
      debug: b.counts.debug,
      info: b.counts.info,
      warn: b.counts.warn,
      error: b.counts.error,
      errorRate: b.errorRate, // null -> gap
      costUsd: b.costUsd,
      cumCostUsd: cum,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      p50: b.latency ? b.latency.p50 : null, // null -> gap
      p95: b.latency ? b.latency.p95 : null,
      p99: b.latency ? b.latency.p99 : null,
    };
  });
}

const LINE_COLORS = ["var(--tb-info)", "var(--tb-acc)", "var(--tb-error)"];

function ChartBody({ kind, rows }: { kind: StatChartKind; rows: Row[] }) {
  const grid = <CartesianGrid strokeDasharray="3 3" stroke="var(--tb-border)" />;
  const xAxis = (
    <XAxis dataKey="bucket" stroke="var(--tb-mut)" tick={{ fontSize: 11 }} />
  );
  const yAxis = <YAxis stroke="var(--tb-mut)" tick={{ fontSize: 11 }} width={48} />;
  const tooltip = (
    <Tooltip
      contentStyle={{
        background: "var(--tb-surface)",
        border: "1px solid var(--tb-border)",
        color: "var(--tb-text)",
      }}
    />
  );

  switch (kind) {
    case "volume":
      return (
        <BarChart data={rows}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {LEVELS.map((lvl) => (
            <Bar
              key={lvl}
              dataKey={lvl}
              stackId="lvl"
              fill={LEVEL_COLOR[lvl]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      );

    case "tokens":
      return (
        <BarChart data={rows}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          <Bar
            dataKey="inputTokens"
            stackId="tok"
            fill="var(--tb-info)"
            isAnimationActive={false}
          />
          <Bar
            dataKey="outputTokens"
            stackId="tok"
            fill="var(--tb-acc)"
            isAnimationActive={false}
          />
        </BarChart>
      );

    case "errorRate":
      return (
        <LineChart data={rows}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          <Line
            type="monotone"
            dataKey="errorRate"
            stroke="var(--tb-error)"
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      );

    case "latency":
      return (
        <LineChart data={rows}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {(["p50", "p95", "p99"] as const).map((k, i) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              stroke={LINE_COLORS[i]}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      );

    case "cost":
      return (
        <ComposedChart data={rows}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          <Bar dataKey="costUsd" fill="var(--tb-acc)" isAnimationActive={false} />
          <Line
            type="monotone"
            dataKey="cumCostUsd"
            stroke="var(--tb-info)"
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      );
  }
}

/**
 * One stats chart (contract C-F9). `kind` selects the series wiring:
 *   volume    — stacked bars per level
 *   errorRate — error-rate % line (null buckets = gaps)
 *   cost      — per-bucket cost bars + running-total line
 *   tokens    — stacked input/output token bars
 *   latency   — p50/p95/p99 lines (null buckets = gaps)
 * null latency/errorRate buckets render as gaps, never zeros (connectNulls=false).
 * In jsdom assert wiring via the figure's data-* attributes + recharts series groups.
 */
export function StatChart({ buckets, kind, width, height = 240 }: StatChartProps) {
  const rows = toRows(buckets);
  const figureProps = {
    role: "img" as const,
    "aria-label": TITLE[kind],
    "data-kind": kind,
    "data-points": String(buckets.length),
    "data-series": SERIES[kind].join(","),
  };

  if (rows.length === 0) {
    return (
      <figure
        {...figureProps}
        style={{
          margin: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height,
          color: "var(--tb-mut)",
          border: "1px dashed var(--tb-border)",
          borderRadius: 8,
        }}
      >
        No data for this range
      </figure>
    );
  }

  const body = <ChartBody kind={kind} rows={rows} />;

  return (
    <figure {...figureProps} style={{ margin: 0 }}>
      {width != null ? (
        // Fixed size: recharts renders directly (used in tests; jsdom can't measure %).
        <div style={{ width, height }}>
          <ResponsiveContainer width={width} height={height}>
            {body}
          </ResponsiveContainer>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          {body}
        </ResponsiveContainer>
      )}
    </figure>
  );
}
