import { render, screen } from "@testing-library/react";
import { StatChart } from "@/components/StatChart";
import type { StatsBucket } from "@/lib/types";

function bucket(over: Partial<StatsBucket> = {}): StatsBucket {
  return {
    bucket: "2026-06-14T00:00:00.000Z",
    total: 0,
    counts: { debug: 0, info: 0, warn: 0, error: 0 },
    latency: null,
    errorRate: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...over,
  };
}

// Fixed dimensions so recharts renders an SVG in jsdom (ResponsiveContainer measures 0 there).
const SIZE = { width: 480, height: 240 } as const;

const SAMPLE: StatsBucket[] = [
  bucket({
    bucket: "2026-06-14T00:00:00.000Z",
    total: 10,
    counts: { debug: 1, info: 6, warn: 2, error: 1 },
    latency: { p50: 10, p95: 100, p99: 200 },
    errorRate: 10,
    costUsd: 0.5,
    inputTokens: 100,
    outputTokens: 40,
  }),
  bucket({
    bucket: "2026-06-14T01:00:00.000Z",
    total: 0,
    counts: { debug: 0, info: 0, warn: 0, error: 0 },
    latency: null, // gap bucket
    errorRate: null, // gap bucket
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  }),
  bucket({
    bucket: "2026-06-14T02:00:00.000Z",
    total: 20,
    counts: { debug: 0, info: 15, warn: 3, error: 2 },
    latency: { p50: 12, p95: 150, p99: 300 },
    errorRate: 10,
    costUsd: 1.25,
    inputTokens: 200,
    outputTokens: 80,
  }),
];

describe("StatChart", () => {
  it("renders a labeled figure carrying the kind and point count", () => {
    const { container } = render(<StatChart buckets={SAMPLE} kind="volume" {...SIZE} />);
    const fig = screen.getByRole("img");
    expect(fig).toHaveAttribute("data-kind", "volume");
    expect(fig).toHaveAttribute("data-points", "3");
    expect(fig).toHaveAccessibleName(/volume/i);
    expect(container.querySelector("svg.recharts-surface")).toBeTruthy();
  });

  it("volume: renders one stacked bar series per level (debug/info/warn/error)", () => {
    const { container } = render(<StatChart buckets={SAMPLE} kind="volume" {...SIZE} />);
    expect(screen.getByRole("img")).toHaveAttribute("data-series", "debug,info,warn,error");
    // recharts renders a .recharts-bar group per <Bar>
    expect(container.querySelectorAll(".recharts-bar").length).toBe(4);
  });

  it("errorRate: renders a single line and skips the null bucket (gap, not zero)", () => {
    const { container } = render(<StatChart buckets={SAMPLE} kind="errorRate" {...SIZE} />);
    const fig = screen.getByRole("img");
    expect(fig).toHaveAttribute("data-kind", "errorRate");
    expect(fig).toHaveAttribute("data-series", "errorRate");
    expect(container.querySelectorAll(".recharts-line").length).toBe(1);
    // 3 buckets, 1 is null -> only 2 plotted dots (the gap has no dot)
    const dots = container.querySelectorAll(".recharts-line-dots .recharts-line-dot");
    expect(dots.length).toBe(2);
  });

  it("latency: renders p50/p95/p99 lines and treats null latency as a gap", () => {
    const { container } = render(<StatChart buckets={SAMPLE} kind="latency" {...SIZE} />);
    expect(screen.getByRole("img")).toHaveAttribute("data-series", "p50,p95,p99");
    expect(container.querySelectorAll(".recharts-line").length).toBe(3);
    // each line: 2 non-null points across 3 buckets => 2 dots per line => 6 total
    const dots = container.querySelectorAll(".recharts-line-dots .recharts-line-dot");
    expect(dots.length).toBe(6);
  });

  it("cost: plots per-bucket cost plus a running-total line", () => {
    const { container } = render(<StatChart buckets={SAMPLE} kind="cost" {...SIZE} />);
    const fig = screen.getByRole("img");
    expect(fig).toHaveAttribute("data-kind", "cost");
    expect(fig).toHaveAttribute("data-series", "costUsd,cumCostUsd");
    expect(container.querySelectorAll(".recharts-bar").length).toBe(1); // per-bucket cost bars
    expect(container.querySelectorAll(".recharts-line").length).toBe(1); // running total line
  });

  it("tokens: renders stacked input/output token bars", () => {
    const { container } = render(<StatChart buckets={SAMPLE} kind="tokens" {...SIZE} />);
    expect(screen.getByRole("img")).toHaveAttribute("data-series", "inputTokens,outputTokens");
    expect(container.querySelectorAll(".recharts-bar").length).toBe(2);
  });

  it("renders an empty-state (no svg) when there are no buckets", () => {
    const { container } = render(<StatChart buckets={[]} kind="volume" {...SIZE} />);
    const fig = screen.getByRole("img");
    expect(fig).toHaveAttribute("data-points", "0");
    expect(fig).toHaveTextContent(/no data/i);
    expect(container.querySelector("svg.recharts-surface")).toBeNull();
  });
});
