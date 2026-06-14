import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimeRangePicker } from "@/components/TimeRangePicker";
import { PRESETS } from "@/lib/time";

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
});
