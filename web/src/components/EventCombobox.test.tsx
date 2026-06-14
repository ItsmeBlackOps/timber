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
});
