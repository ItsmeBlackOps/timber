import { render, screen } from "@testing-library/react";
import { HealthDot } from "@/components/HealthDot";
import type { Health } from "@/lib/types";

function makeHealth(over: Partial<Health> = {}): Health {
  return {
    ok: true,
    wal: { totalBytes: 0, backlogBytes: 0, overBudget: false },
    flusher: {
      running: true,
      caughtUp: true,
      flushedTotal: 0,
      lastError: null,
    },
    mongo: { connected: true },
    ...over,
  };
}

describe("HealthDot", () => {
  it("renders green/healthy when ok && mongo.connected", () => {
    render(<HealthDot health={makeHealth()} />);
    const dot = screen.getByRole("status");
    expect(dot).toHaveAttribute("data-health", "ok");
    expect(dot).toHaveAccessibleName(/health|ok|healthy/i);
  });

  it("renders red/unhealthy when ok is false", () => {
    render(<HealthDot health={makeHealth({ ok: false })} />);
    expect(screen.getByRole("status")).toHaveAttribute("data-health", "down");
  });

  it("renders red/unhealthy when mongo is disconnected even if ok", () => {
    render(
      <HealthDot health={makeHealth({ mongo: { connected: false } })} />,
    );
    expect(screen.getByRole("status")).toHaveAttribute("data-health", "down");
  });

  it("exposes a tooltip describing wal backlog, flusher, and mongo state", () => {
    render(
      <HealthDot
        health={makeHealth({
          wal: { totalBytes: 4096, backlogBytes: 2048, overBudget: true },
          flusher: {
            running: false,
            caughtUp: false,
            flushedTotal: 7,
            lastError: "boom",
          },
          mongo: { connected: false },
        })}
      />,
    );
    const dot = screen.getByRole("status");
    const tip = dot.getAttribute("title") ?? "";
    expect(tip).toMatch(/backlog/i);
    expect(tip).toMatch(/2048|2\.0 ?KB|2 ?KB/i); // backlog bytes surfaced
    expect(tip).toMatch(/flush/i);
    expect(tip).toMatch(/mongo/i);
  });

  it("renders an unknown state when health is undefined (not yet loaded)", () => {
    render(<HealthDot health={undefined} />);
    expect(screen.getByRole("status")).toHaveAttribute(
      "data-health",
      "unknown",
    );
  });
});
