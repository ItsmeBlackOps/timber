import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogRow } from "@/components/LogRow";
import * as time from "@/lib/time";
import type { LogDoc, Level } from "@/lib/types";

function makeDoc(over: Partial<LogDoc> = {}): LogDoc {
  return {
    _id: "doc-1",
    app: "billing",
    env: "prod",
    event: "charge.succeeded",
    level: "info",
    ts: "2026-06-14T05:00:00.000Z",
    message: "Payment captured",
    ids: { userEmail: "a@b.com" },
    data: {},
    receivedAt: "2026-06-14T05:00:01.000Z",
    expiresAt: "2026-07-14T05:00:01.000Z",
    ...over,
  };
}

beforeEach(() => {
  // Freeze "now" 5 minutes after the doc's ts for a stable relative label.
  // shouldAdvanceTime keeps real time flowing so userEvent's internal timers
  // resolve (otherwise pointer events hang) while Date.now() stays anchored.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-06-14T05:05:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LogRow", () => {
  it("renders app, event and message", () => {
    render(<LogRow doc={makeDoc()} selected={false} onClick={() => {}} />);
    expect(screen.getByText("billing")).toBeInTheDocument();
    expect(screen.getByText("charge.succeeded")).toBeInTheDocument();
    expect(screen.getByText("Payment captured")).toBeInTheDocument();
  });

  it("shows a level chip carrying the level (color via token)", () => {
    render(
      <LogRow doc={makeDoc({ level: "error" })} selected={false} onClick={() => {}} />,
    );
    const chip = screen.getByTestId("level-chip");
    expect(chip).toHaveAttribute("data-level", "error");
    // Color comes from the matching CSS var, never a hardcoded hex.
    expect(chip.getAttribute("style") ?? "").toMatch(/var\(--tb-error\)/);
    expect(chip).toHaveTextContent(/error/i);
  });

  it.each<[Level, string]>([
    ["debug", "--tb-debug"],
    ["info", "--tb-info"],
    ["warn", "--tb-warn"],
    ["error", "--tb-error"],
  ])("maps level %s to its token color", (level, token) => {
    render(<LogRow doc={makeDoc({ level })} selected={false} onClick={() => {}} />);
    const chip = screen.getByTestId("level-chip");
    expect(chip.getAttribute("style") ?? "").toContain(`var(${token})`);
  });

  it("shows relative time with absolute time available on hover (title)", () => {
    render(<LogRow doc={makeDoc()} selected={false} onClick={() => {}} />);
    const time = screen.getByTestId("row-time");
    expect(time).toHaveTextContent(/5m ago/);
    // Absolute wall-clock in the title for hover.
    expect(time.getAttribute("title") ?? "").toMatch(/2026-06-14/);
  });

  it("falls back to receivedAt when ts is missing", () => {
    render(
      <LogRow
        doc={makeDoc({ ts: undefined, receivedAt: "2026-06-14T05:04:00.000Z" })}
        selected={false}
        onClick={() => {}}
      />,
    );
    // 1 minute before frozen now.
    expect(screen.getByTestId("row-time")).toHaveTextContent(/1m ago/);
  });

  it("truncates a very long message (single line, not the full text node)", () => {
    const long = "z".repeat(500);
    render(
      <LogRow doc={makeDoc({ message: long })} selected={false} onClick={() => {}} />,
    );
    const msg = screen.getByTestId("row-message");
    // The full message is the title (hover) but the rendered cell clamps via CSS.
    expect(msg.getAttribute("title") ?? "").toBe(long);
    const style = msg.getAttribute("style") ?? "";
    expect(style).toMatch(/text-overflow:\s*ellipsis/);
    expect(style).toMatch(/overflow:\s*hidden/);
  });

  it("calls onClick when the row is activated", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<LogRow doc={makeDoc()} selected={false} onClick={onClick} />);
    await user.click(screen.getByRole("row"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // --- Keyboard operability (WCAG 2.1.1) -----------------------------------
  // The row is the sole gateway to the DetailPanel (inspect / pivot-on-value /
  // copy-JSON / copy-deep-link), so it MUST be reachable and activatable by
  // keyboard, not just the mouse.

  it("is focusable via the keyboard (tabIndex 0)", async () => {
    const user = userEvent.setup();
    render(<LogRow doc={makeDoc()} selected={false} onClick={() => {}} />);
    const row = screen.getByRole("row");
    // Exposed to the tab order.
    expect(row).toHaveAttribute("tabindex", "0");
    // And Tab actually lands focus on it.
    await user.tab();
    expect(row).toHaveFocus();
  });

  it("activates onClick when Enter is pressed on the focused row", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<LogRow doc={makeDoc()} selected={false} onClick={onClick} />);
    const row = screen.getByRole("row");
    row.focus();
    await user.keyboard("{Enter}");
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("activates onClick when Space is pressed and prevents the page from scrolling", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<LogRow doc={makeDoc()} selected={false} onClick={onClick} />);
    const row = screen.getByRole("row");
    row.focus();
    // Dispatch a real keydown so we can assert defaultPrevented (Space would
    // otherwise scroll the page).
    const ev = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    row.dispatchEvent(ev);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    // Sanity: not triggered by an ordinary character key.
    onClick.mockClear();
    await user.keyboard("a");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("exposes its cells as gridcell (ResultsTable advertises role=grid, where cells must be gridcell, not the table-only role=cell)", () => {
    render(<LogRow doc={makeDoc()} selected={false} onClick={() => {}} />);
    // Every column is a gridcell so the ARIA grid pattern is well-formed.
    expect(screen.getAllByRole("gridcell")).toHaveLength(5);
    // And the obsolete table-only role is gone.
    expect(screen.queryAllByRole("cell")).toHaveLength(0);
    // Known cells are still addressable.
    expect(screen.getByTestId("row-message")).toHaveAttribute("role", "gridcell");
  });

  it("injects a single :focus-visible outline rule (visible keyboard focus, theme-token color)", () => {
    render(<LogRow doc={makeDoc()} selected={false} onClick={() => {}} />);
    const styleEl = document.getElementById("tb-logrow-focus");
    expect(styleEl).not.toBeNull();
    const css = styleEl?.textContent ?? "";
    expect(css).toMatch(/:focus-visible/);
    expect(css).toMatch(/var\(--tb-acc\)/);
    expect(css).not.toMatch(/#[0-9a-f]{3,6}/i); // no hardcoded hex
    // Re-rendering more rows must not duplicate the global rule.
    render(<LogRow doc={makeDoc({ _id: "doc-2" })} selected={false} onClick={() => {}} />);
    expect(document.querySelectorAll("#tb-logrow-focus")).toHaveLength(1);
  });

  it("marks the selected row via aria-selected", () => {
    render(<LogRow doc={makeDoc()} selected onClick={() => {}} />);
    expect(screen.getByRole("row")).toHaveAttribute("aria-selected", "true");
  });

  it("renders an em dash when there is no message", () => {
    render(
      <LogRow doc={makeDoc({ message: undefined })} selected={false} onClick={() => {}} />,
    );
    expect(screen.getByTestId("row-message")).toHaveTextContent("—");
  });

  // --- Re-render hygiene (perf finding) ------------------------------------
  // ResultsTable hands each row REFERENCE-STABLE props (a cached per-row
  // onClick + the same doc/selected) precisely so the row can skip re-rendering
  // when ExploreRoute re-renders on every 2s live-tail tick / facet churn. That
  // whole design only pays off if LogRow is wrapped in React.memo — otherwise
  // every visible row re-renders on each parent tick no matter how stable its
  // props are. These tests pin that the REAL component (not a test mock) is
  // memoized; ResultsTable.test mocks LogRow with memo(), so it cannot catch a
  // plain-function LogRow here.

  it("is wrapped in React.memo", () => {
    expect((LogRow as unknown as { $$typeof?: symbol }).$$typeof).toBe(
      Symbol.for("react.memo"),
    );
  });

  it("skips re-render when re-rendered with identical reference-stable props", async () => {
    const user = userEvent.setup();
    const doc = makeDoc();
    const onClick = () => {};

    // Count actual executions of LogRow's render body. The row calls
    // fmtRelative exactly once per render, so a spy on it (keeping the real
    // implementation, so the rest of the DOM is unaffected) is a precise render
    // counter for the REAL component — unlike a wrapping <Profiler>, which fires
    // for the parent's own commit even when a memoized child bails out.
    const spy = vi.spyOn(time, "fmtRelative");

    // Parent owns an unrelated piece of state (mirrors ExploreRoute churn). When
    // it changes, the <LogRow> element is recreated but its props are the SAME
    // references, so a memoized row must not re-render.
    function Harness() {
      const [, setTick] = useState(0);
      return (
        <>
          <button onClick={() => setTick((t) => t + 1)}>bump</button>
          <LogRow doc={doc} selected={false} onClick={onClick} />
        </>
      );
    }

    render(<Harness />);
    const initial = spy.mock.calls.length;
    expect(initial).toBeGreaterThan(0); // rendered (and formatted time) at least once

    await user.click(screen.getByText("bump"));

    // No prop changed by reference, so the memoized row short-circuits: its
    // render body does NOT run again, so fmtRelative is not called again. A
    // plain-function LogRow would re-render (and bump this count) on the tick.
    expect(spy.mock.calls.length).toBe(initial);
    spy.mockRestore();
  });
});
