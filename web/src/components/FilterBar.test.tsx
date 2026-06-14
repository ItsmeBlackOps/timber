import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterBar } from "@/components/FilterBar";
import type { Filters } from "@/lib/filters";

// FilterBar composes EventCombobox, which reads useEvents(). Mock the hook.
const useEventsMock = vi.hoisted(() => ({ useEvents: vi.fn() }));
vi.mock("@/hooks", () => useEventsMock);

beforeEach(() => {
  useEventsMock.useEvents.mockReturnValue({
    data: { apps: { api: ["http.request"] } },
  } as ReturnType<typeof useEventsMock.useEvents>);
});

const base: Filters = { levels: [], ids: [], data: [] };

// FilterBar's inputs are controlled by the `filters` prop. For multi-keystroke
// typing the prop must update between keystrokes, so drive it through state and
// forward each emitted Filters to a spy.
function Controlled({
  initial,
  onChange,
}: {
  initial: Filters;
  onChange: (f: Filters) => void;
}) {
  const [filters, setFilters] = useState<Filters>(initial);
  return (
    <FilterBar
      filters={filters}
      onChange={(f) => {
        setFilters(f);
        onChange(f);
      }}
    />
  );
}

describe("FilterBar", () => {
  it("renders the composed filter controls", () => {
    render(<FilterBar filters={base} onChange={() => {}} />);
    // level chips
    expect(screen.getByRole("button", { name: /error/i })).toBeInTheDocument();
    // event combobox
    expect(screen.getByRole("combobox", { name: /event/i })).toBeInTheDocument();
    // free-text q
    expect(screen.getByLabelText(/message|text|search/i)).toBeInTheDocument();
    // a time preset
    expect(screen.getByRole("button", { name: /last hour/i })).toBeInTheDocument();
  });

  it("emits a complete Filters when a level chip is toggled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FilterBar
        filters={{ ...base, app: "api", levels: ["error"] }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: /warn/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Filters;
    // preserves other fields
    expect(next.app).toBe("api");
    expect(new Set(next.levels)).toEqual(new Set(["error", "warn"]));
    // full Filters shape preserved
    expect(next.ids).toEqual([]);
    expect(next.data).toEqual([]);
  });

  it("emits q in the Filters when typing free text", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled initial={base} onChange={onChange} />);
    await user.type(screen.getByLabelText(/message|text|search/i), "boom");
    const last = onChange.mock.calls.at(-1)![0] as Filters;
    expect(last.q).toBe("boom");
  });

  it("emits the event prefix in the Filters via the combobox", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled initial={{ ...base, app: "api" }} onChange={onChange} />);
    await user.type(screen.getByRole("combobox", { name: /event/i }), "http.");
    const last = onChange.mock.calls.at(-1)![0] as Filters;
    expect(last.event).toBe("http.");
  });

  it("emits a time window in the Filters when a preset is chosen", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilterBar filters={base} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /last hour/i }));
    const last = onChange.mock.calls.at(-1)![0] as Filters;
    expect(typeof last.from).toBe("string");
    expect(typeof last.to).toBe("string");
  });

  it("adds an id filter row through the advanced section", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilterBar filters={base} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /add id filter/i }));
    const last = onChange.mock.calls.at(-1)![0] as Filters;
    expect(last.ids).toEqual([{ key: "", value: "" }]);
  });
});
