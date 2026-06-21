import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EventCombobox } from "@/components/EventCombobox";

// EventCombobox derives suggestions from useEvents() (contract C-F9 / C-F8).
// Mock the hook so the component test doesn't touch the network.
const useEventsMock = vi.hoisted(() => ({ useEvents: vi.fn() }));
vi.mock("@/hooks", () => useEventsMock);

// EventCombobox is controlled: its input reflects `value`. To exercise multi-
// keystroke typing we drive `value` through state and forward each change to a
// spy so assertions can inspect the emitted prefix.
function Controlled({
  app,
  initial = "",
  onChange,
}: {
  app: string | undefined;
  initial?: string;
  onChange: (v: string | undefined) => void;
}) {
  const [value, setValue] = useState<string | undefined>(initial);
  return (
    <EventCombobox
      app={app}
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

function mockEvents(apps: Record<string, string[]>) {
  useEventsMock.useEvents.mockReturnValue({ data: { apps } } as ReturnType<
    typeof useEventsMock.useEvents
  >);
}

beforeEach(() => {
  useEventsMock.useEvents.mockReset();
  mockEvents({
    api: ["http.request", "http.error"],
    worker: ["cron.run", "job.done"],
  });
});

describe("EventCombobox", () => {
  it("renders the current value in the input", () => {
    render(<EventCombobox app={undefined} value="http." onChange={() => {}} />);
    expect(screen.getByRole("combobox", { name: /event/i })).toHaveValue("http.");
  });

  it("emits the typed prefix as the user types", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled app={undefined} onChange={onChange} />);
    await user.type(screen.getByRole("combobox", { name: /event/i }), "ht");
    // last call carries the full typed value
    expect(onChange).toHaveBeenLastCalledWith("ht");
  });

  it("emits undefined when the field is cleared", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EventCombobox app={undefined} value="x" onChange={onChange} />);
    await user.clear(screen.getByRole("combobox", { name: /event/i }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("suggests event prefixes from useEvents (all apps when no app)", async () => {
    const user = userEvent.setup();
    render(<EventCombobox app={undefined} value="" onChange={() => {}} />);
    await user.click(screen.getByRole("combobox", { name: /event/i }));
    const list = screen.getByRole("listbox");
    expect(within(list).getByText("http.request")).toBeInTheDocument();
    expect(within(list).getByText("cron.run")).toBeInTheDocument();
  });

  it("scopes suggestions to the selected app", async () => {
    const user = userEvent.setup();
    render(<EventCombobox app="api" value="" onChange={() => {}} />);
    await user.click(screen.getByRole("combobox", { name: /event/i }));
    const list = screen.getByRole("listbox");
    expect(within(list).getByText("http.request")).toBeInTheDocument();
    expect(within(list).queryByText("cron.run")).not.toBeInTheDocument();
  });

  it("filters suggestions by what is typed", async () => {
    const user = userEvent.setup();
    render(<Controlled app="api" onChange={() => {}} />);
    const input = screen.getByRole("combobox", { name: /event/i });
    await user.type(input, "error");
    const list = screen.getByRole("listbox");
    expect(within(list).getByText("http.error")).toBeInTheDocument();
    expect(within(list).queryByText("http.request")).not.toBeInTheDocument();
  });

  it("emits the suggestion when one is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EventCombobox app="api" value="" onChange={onChange} />);
    await user.click(screen.getByRole("combobox", { name: /event/i }));
    await user.click(screen.getByText("http.request"));
    expect(onChange).toHaveBeenLastCalledWith("http.request");
  });

  // --- WAI-ARIA combobox/listbox pattern (a11y) ---

  it("associates the input with the listbox via aria-controls", async () => {
    const user = userEvent.setup();
    render(<EventCombobox app="api" value="" onChange={() => {}} />);
    const input = screen.getByRole("combobox", { name: /event/i });
    await user.click(input);
    const list = screen.getByRole("listbox");
    expect(list).toHaveAttribute("id");
    const listId = list.getAttribute("id");
    expect(listId).toBeTruthy();
    expect(input).toHaveAttribute("aria-controls", listId!);
  });

  it("selects the highlighted option with ArrowDown + Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EventCombobox app="api" value="" onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: /event/i });
    await user.click(input);
    // suggestions for "api" sorted: http.error, http.request
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("http.error");
  });

  it("tracks the highlighted option via aria-activedescendant", async () => {
    const user = userEvent.setup();
    render(<EventCombobox app="api" value="" onChange={() => {}} />);
    const input = screen.getByRole("combobox", { name: /event/i });
    await user.click(input);
    expect(input).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{ArrowDown}");
    const active = input.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    const list = screen.getByRole("listbox");
    const firstOption = within(list).getByText("http.error").closest("[role=option]");
    expect(firstOption).toHaveAttribute("id", active!);
    expect(firstOption).toHaveAttribute("aria-selected", "true");
  });

  it("wraps from the last option to the first with ArrowDown", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EventCombobox app="api" value="" onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: /event/i });
    await user.click(input);
    // 2 options; down past the end wraps back to the first (http.error).
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("http.error");
  });

  it("wraps to the last option with ArrowUp from the unhighlighted state", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EventCombobox app="api" value="" onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: /event/i });
    await user.click(input);
    await user.keyboard("{ArrowUp}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith("http.request");
  });

  it("closes the listbox on Escape without emitting", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EventCombobox app="api" value="" onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: /event/i });
    await user.click(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await user.keyboard("{ArrowDown}{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Enter without a highlighted option does not emit a suggestion", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EventCombobox app="api" value="" onChange={onChange} />);
    const input = screen.getByRole("combobox", { name: /event/i });
    await user.click(input);
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });
});
