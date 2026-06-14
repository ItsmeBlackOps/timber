import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogRow } from "@/components/LogRow";
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
});
