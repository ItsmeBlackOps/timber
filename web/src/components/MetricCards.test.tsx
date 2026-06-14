import { render, screen, within } from "@testing-library/react";
import { MetricCards } from "@/components/MetricCards";
import type { StatsBucket, StatsResponse } from "@/lib/types";

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

function stats(buckets: StatsBucket[]): StatsResponse {
  return { group: "hour", from: "2026-06-14T00:00:00.000Z", to: "2026-06-14T03:00:00.000Z", buckets };
}

/** Read the rendered numeric value for a metric card by its stable data-metric id. */
function metricValue(id: string): string {
  const card = screen.getByTestId(`metric-${id}`);
  return within(card).getByTestId("metric-value").textContent ?? "";
}

describe("MetricCards", () => {
  it("renders the five metric cards with accessible labels", () => {
    render(<MetricCards stats={stats([bucket()])} />);
    expect(screen.getByTestId("metric-total")).toHaveTextContent(/total|events/i);
    expect(screen.getByTestId("metric-errorRate")).toHaveTextContent(/error/i);
    expect(screen.getByTestId("metric-cost")).toHaveTextContent(/cost/i);
    expect(screen.getByTestId("metric-p95")).toHaveTextContent(/p95|latency/i);
    expect(screen.getByTestId("metric-tokens")).toHaveTextContent(/token/i);
  });

  it("sums total events across buckets", () => {
    render(
      <MetricCards
        stats={stats([
          bucket({ total: 10 }),
          bucket({ total: 5 }),
          bucket({ total: 7 }),
        ])}
      />,
    );
    expect(metricValue("total")).toMatch(/\b22\b/);
  });

  it("computes error rate % = errors / total * 100 (rounded for display)", () => {
    // total = 200, errors = 3 -> 1.5%
    render(
      <MetricCards
        stats={stats([
          bucket({ total: 100, counts: { debug: 0, info: 99, warn: 0, error: 1 } }),
          bucket({ total: 100, counts: { debug: 0, info: 98, warn: 0, error: 2 } }),
        ])}
      />,
    );
    expect(metricValue("errorRate")).toMatch(/1\.5\s*%/);
  });

  it("shows 0% error rate (not NaN) when there are no events", () => {
    render(<MetricCards stats={stats([bucket()])} />);
    const v = metricValue("errorRate");
    expect(v).not.toMatch(/nan/i);
    expect(v).toMatch(/0\s*%/);
  });

  it("sums costUsd across buckets and renders rounded USD", () => {
    render(
      <MetricCards
        stats={stats([
          bucket({ costUsd: 0.001234 }),
          bucket({ costUsd: 0.004321 }),
          bucket({ costUsd: 1.5 }),
        ])}
      />,
    );
    // 0.001234 + 0.004321 + 1.5 = 1.505555 -> rounded display keeps the dollars value
    const v = metricValue("cost");
    expect(v).toMatch(/1\.5/); // rounded; not the full float
    expect(v).not.toMatch(/1\.505555/);
  });

  it("reports a representative p95 (peak across non-null latency buckets), rounded", () => {
    render(
      <MetricCards
        stats={stats([
          bucket({ latency: { p50: 10, p95: 120.7, p99: 200 } }),
          bucket({ latency: null }),
          bucket({ latency: { p50: 12, p95: 305.2, p99: 600 } }),
        ])}
      />,
    );
    // representative = max p95 = 305.2 -> rounded 305
    expect(metricValue("p95")).toMatch(/\b305\b/);
  });

  it("shows a dash for p95 when no bucket has latency", () => {
    render(<MetricCards stats={stats([bucket(), bucket()])} />);
    expect(metricValue("p95")).toMatch(/[—–-]/);
  });

  it("sums input + output tokens across buckets", () => {
    render(
      <MetricCards
        stats={stats([
          bucket({ inputTokens: 100, outputTokens: 50 }),
          bucket({ inputTokens: 200, outputTokens: 25 }),
        ])}
      />,
    );
    // 100+50+200+25 = 375
    expect(metricValue("tokens")).toMatch(/375/);
  });

  it("renders zeroed cards (no crash) when stats is undefined", () => {
    render(<MetricCards stats={undefined} />);
    expect(metricValue("total")).toMatch(/\b0\b/);
    expect(metricValue("errorRate")).toMatch(/0\s*%/);
  });

  it("renders zeroed cards when there are no buckets", () => {
    render(<MetricCards stats={stats([])} />);
    expect(metricValue("total")).toMatch(/\b0\b/);
    expect(metricValue("tokens")).toMatch(/\b0\b/);
  });
});
