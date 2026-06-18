import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimeRangePicker } from "@/components/TimeRangePicker";
import { PRESETS, presetRange } from "@/lib/time";

describe("TimeRangePicker", () => {
  it("renders a button for every preset", () => {
    render(<TimeRangePicker from={undefined} to={undefined} onChange={() => {}} />);
    for (const p of PRESETS) {
      expect(
        screen.getByRole("button", { name: new RegExp(p.label, "i") }),
      ).toBeInTheDocument();
    }
  });

  it("emits a from/to window when a preset is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimeRangePicker from={undefined} to={undefined} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /last hour/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const arg = onChange.mock.calls[0][0] as { from?: string; to?: string };
    expect(typeof arg.from).toBe("string");
    expect(typeof arg.to).toBe("string");
    // ~1h apart
    const span = new Date(arg.to!).getTime() - new Date(arg.from!).getTime();
    expect(span).toBeGreaterThan(59 * 60_000);
    expect(span).toBeLessThan(61 * 60_000);
    // both ISO strings
    expect(arg.from).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(arg.to).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("emits a custom 'from' bound (as ISO) when the from field changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimeRangePicker from={undefined} to={undefined} onChange={onChange} />);

    const fromInput = screen.getByLabelText(/from/i);
    await user.type(fromInput, "2026-06-01T08:30");

    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)![0] as { from?: string; to?: string };
    // value normalized to a full ISO instant
    expect(last.from).toBe(new Date("2026-06-01T08:30").toISOString());
  });

  it("emits a custom 'to' bound (as ISO) when the to field changes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TimeRangePicker
        from="2026-06-01T00:00:00.000Z"
        to={undefined}
        onChange={onChange}
      />,
    );

    const toInput = screen.getByLabelText(/to/i);
    await user.type(toInput, "2026-06-02T10:00");

    const last = onChange.mock.calls.at(-1)![0] as { from?: string; to?: string };
    expect(last.to).toBe(new Date("2026-06-02T10:00").toISOString());
    // preserves the existing from bound
    expect(last.from).toBe("2026-06-01T00:00:00.000Z");
  });

  // ---- active-preset highlighting (parity with Stats: activePresetId + aria-pressed) ----

  it("marks the preset matching the current window as aria-pressed", () => {
    // A window exactly one hour wide should light up the "Last hour" preset.
    const { from, to } = presetRange("1h", new Date());
    render(<TimeRangePicker from={from} to={to} onChange={() => {}} />);

    expect(
      screen.getByRole("button", { name: /last hour/i }),
    ).toHaveAttribute("aria-pressed", "true");
    // and only that one
    expect(
      screen.getByRole("button", { name: /last 15 min/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("marks no preset as pressed when the window matches none", () => {
    // 90-minute window matches no preset.
    const to = new Date("2026-06-01T12:00:00.000Z");
    const from = new Date(to.getTime() - 90 * 60_000);
    render(
      <TimeRangePicker
        from={from.toISOString()}
        to={to.toISOString()}
        onChange={() => {}}
      />,
    );
    for (const p of PRESETS) {
      expect(
        screen.getByRole("button", { name: new RegExp(p.label, "i") }),
      ).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("every preset carries an aria-pressed attribute (so AT can read state)", () => {
    render(<TimeRangePicker from={undefined} to={undefined} onChange={() => {}} />);
    for (const p of PRESETS) {
      expect(
        screen.getByRole("button", { name: new RegExp(p.label, "i") }),
      ).toHaveAttribute("aria-pressed");
    }
  });

  it("reflects the active preset after clicking it (round-trips via props)", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [range, setRange] = useState<{ from?: string; to?: string }>({});
      return <TimeRangePicker from={range.from} to={range.to} onChange={setRange} />;
    }
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: /last 6 hours/i }));

    expect(
      screen.getByRole("button", { name: /last 6 hours/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  // ---- from <= to validation (spec §7: 400 surfaces inline on the offending control) ----

  it("does not emit an inverted window and shows an inline error when to < from", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TimeRangePicker
        from="2026-06-10T00:00:00.000Z"
        to={undefined}
        onChange={onChange}
      />,
    );

    // Pick a `to` that is BEFORE the existing `from`.
    const toInput = screen.getByLabelText(/^to$/i);
    await user.type(toInput, "2026-06-01T00:00");

    // No inverted range escapes to the parent.
    for (const call of onChange.mock.calls) {
      const arg = call[0] as { from?: string; to?: string };
      if (arg.from && arg.to) {
        expect(new Date(arg.from).getTime()).toBeLessThanOrEqual(
          new Date(arg.to).getTime(),
        );
      }
    }
    // An inline error is shown.
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("alert").textContent ?? "").toMatch(/from.*to|after|before|range/i);
  });

  it("does not emit an inverted window when from is moved after to", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TimeRangePicker
        from={undefined}
        to="2026-06-01T00:00:00.000Z"
        onChange={onChange}
      />,
    );

    const fromInput = screen.getByLabelText(/^from$/i);
    await user.type(fromInput, "2026-06-10T00:00");

    for (const call of onChange.mock.calls) {
      const arg = call[0] as { from?: string; to?: string };
      if (arg.from && arg.to) {
        expect(new Date(arg.from).getTime()).toBeLessThanOrEqual(
          new Date(arg.to).getTime(),
        );
      }
    }
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("clears the error and emits once the range becomes valid again", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [range, setRange] = useState<{ from?: string; to?: string }>({
        from: "2026-06-10T00:00:00.000Z",
        to: undefined,
      });
      return <TimeRangePicker from={range.from} to={range.to} onChange={setRange} />;
    }
    render(<Harness />);

    const toInput = screen.getByLabelText(/^to$/i);
    // First an invalid (inverted) value -> error.
    await user.type(toInput, "2026-06-01T00:00");
    expect(screen.queryByRole("alert")).toBeInTheDocument();

    // Now correct it to a value after `from`.
    await user.clear(toInput);
    await user.type(toInput, "2026-06-20T00:00");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    // The corrected, valid window reaches the parent and is reflected back.
    expect(toInput).toHaveValue("2026-06-20T00:00");
  });

  it("still emits a valid window with both bounds present (from < to)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TimeRangePicker
        from="2026-06-01T00:00:00.000Z"
        to={undefined}
        onChange={onChange}
      />,
    );
    const toInput = screen.getByLabelText(/^to$/i);
    await user.type(toInput, "2026-06-02T00:00");

    const last = onChange.mock.calls.at(-1)![0] as { from?: string; to?: string };
    expect(last.to).toBe(new Date("2026-06-02T00:00").toISOString());
    expect(last.from).toBe("2026-06-01T00:00:00.000Z");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
