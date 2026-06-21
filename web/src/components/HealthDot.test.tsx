import { fireEvent, render, screen } from "@testing-library/react";
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

  // WCAG 1.4.1 (Use of Color): state must be conveyed by something other than
  // the dot's color — a visible text label here.
  it("conveys state with a visible, color-independent text cue", () => {
    const { rerender } = render(<HealthDot health={makeHealth()} />);
    const okText = screen.getByTestId("health-label").textContent ?? "";
    expect(okText).toMatch(/healthy|ok|up/i);

    rerender(<HealthDot health={makeHealth({ ok: false })} />);
    const downText = screen.getByTestId("health-label").textContent ?? "";
    expect(downText).toMatch(/unhealthy|down|degraded|issue/i);

    rerender(<HealthDot health={undefined} />);
    const unknownText = screen.getByTestId("health-label").textContent ?? "";
    expect(unknownText).toMatch(/checking|unknown|…/i);

    // The three states must be visually distinguishable by text alone.
    expect(new Set([okText, downText, unknownText]).size).toBe(3);
  });

  // WCAG 4.1.2 / keyboard: the rich detail must be reachable by keyboard and
  // announced by a screen reader — not only via the native `title` tooltip.
  it("exposes the detail to keyboard/SR via a focusable element + aria-describedby", () => {
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
    // Keyboard-focusable.
    expect(dot).toHaveAttribute("tabindex", "0");
    // Detail linked via aria-describedby to an in-DOM element (SR announces it).
    const id = dot.getAttribute("aria-describedby");
    expect(id).toBeTruthy();
    const desc = document.getElementById(id as string);
    expect(desc).not.toBeNull();
    expect(desc).toHaveTextContent(/backlog/i);
    expect(desc).toHaveTextContent(/2048|2\.0 ?KB/i);
    expect(desc).toHaveTextContent(/flush/i);
    expect(desc).toHaveTextContent(/mongo/i);
  });

  it("opens a visible detail disclosure on focus and dismisses it on Escape", () => {
    render(<HealthDot health={makeHealth()} />);
    const dot = screen.getByRole("status");
    expect(screen.queryByTestId("health-detail-popover")).not.toBeInTheDocument();

    fireEvent.focus(dot);
    expect(screen.getByTestId("health-detail-popover")).toBeInTheDocument();

    fireEvent.keyDown(dot, { key: "Escape" });
    expect(screen.queryByTestId("health-detail-popover")).not.toBeInTheDocument();
  });
});
