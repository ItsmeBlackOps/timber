import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FindByBar } from "@/components/FindByBar";
import type { FacetsResponse, GroupByResponse } from "@/lib/types";

// FindByBar consumes useFacets (key options) + useGroupBy (value autocomplete).
// We mock both hooks so the component is exercised in isolation (contract C-F9).
const useFacets = vi.fn();
const useGroupBy = vi.fn();

vi.mock("@/hooks/useFacets", () => ({
  useFacets: (...args: unknown[]) => useFacets(...args),
}));
vi.mock("@/hooks/useGroupBy", () => ({
  useGroupBy: (...args: unknown[]) => useGroupBy(...args),
}));

function facets(idsKeys: string[]): { data: FacetsResponse } {
  return {
    data: {
      window: { from: "2026-06-14T00:00:00.000Z", to: "2026-06-14T01:00:00.000Z" },
      idsKeys,
      dataPaths: [],
    },
  };
}

function groupby(values: string[]): { data: GroupByResponse } {
  return {
    data: {
      by: "ids.userEmail",
      total: values.length,
      groups: values.map((v, i) => ({ value: v, count: values.length - i })),
      otherCount: 0,
      window: { from: "2026-06-17T12:00:00.000Z", to: "2026-06-18T12:00:00.000Z" },
    },
  };
}

beforeEach(() => {
  useFacets.mockReset();
  useGroupBy.mockReset();
  // Sensible defaults; individual tests override as needed.
  useFacets.mockReturnValue(facets(["userEmail", "userId", "orgId"]));
  useGroupBy.mockReturnValue({ data: undefined });
});

describe("FindByBar", () => {
  it("populates the key options from useFacets idsKeys", () => {
    render(<FindByBar onAdd={() => {}} />);
    const select = screen.getByRole("combobox", { name: /key|field|find/i });
    const options = Array.from(
      select.querySelectorAll("option"),
    ).map((o) => o.textContent);
    expect(options).toEqual(
      expect.arrayContaining(["userEmail", "userId", "orgId"]),
    );
  });

  it("defaults the selected key to userEmail when present", () => {
    render(<FindByBar onAdd={() => {}} />);
    const select = screen.getByRole<HTMLSelectElement>("combobox", {
      name: /key|field|find/i,
    });
    expect(select.value).toBe("userEmail");
  });

  it("queries useGroupBy with by=ids.<key> and the typed value as `like`", async () => {
    const user = userEvent.setup();
    render(<FindByBar onAdd={() => {}} />);

    await user.type(screen.getByRole("combobox", { name: /value/i }), "ann");

    await waitFor(() => {
      const lastCall = useGroupBy.mock.calls.at(-1);
      expect(lastCall?.[0]).toBe("ids.userEmail");
      expect(lastCall?.[2]).toMatchObject({ like: "ann" });
    });
  });

  it("renders value suggestions returned by useGroupBy", async () => {
    const user = userEvent.setup();
    useGroupBy.mockReturnValue(groupby(["anna@x.io", "annie@x.io"]));
    render(<FindByBar onAdd={() => {}} />);

    await user.type(screen.getByRole("combobox", { name: /value/i }), "ann");

    expect(await screen.findByText("anna@x.io")).toBeInTheDocument();
    expect(screen.getByText("annie@x.io")).toBeInTheDocument();
  });

  it("emits ids.<key>=value via onAdd when a suggestion is clicked", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    useGroupBy.mockReturnValue(groupby(["anna@x.io"]));
    render(<FindByBar onAdd={onAdd} />);

    await user.type(screen.getByRole("combobox", { name: /value/i }), "ann");
    await user.click(await screen.findByText("anna@x.io"));

    expect(onAdd).toHaveBeenCalledWith({ key: "userEmail", value: "anna@x.io" });
  });

  it("emits the typed value on Enter / Add even without picking a suggestion", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<FindByBar onAdd={onAdd} />);

    const input = screen.getByRole("combobox", { name: /value/i });
    await user.type(input, "u_123");
    await user.click(screen.getByRole("button", { name: /add|find/i }));

    expect(onAdd).toHaveBeenCalledWith({ key: "userEmail", value: "u_123" });
  });

  it("respects a changed key when emitting", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<FindByBar onAdd={onAdd} />);

    await user.selectOptions(
      screen.getByRole("combobox", { name: /key|field|find/i }),
      "orgId",
    );
    await user.type(screen.getByRole("combobox", { name: /value/i }), "acme");
    await user.click(screen.getByRole("button", { name: /add|find/i }));

    expect(onAdd).toHaveBeenCalledWith({ key: "orgId", value: "acme" });
  });

  it("does not emit when the value is blank", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<FindByBar onAdd={onAdd} />);

    await user.click(screen.getByRole("button", { name: /add|find/i }));

    expect(onAdd).not.toHaveBeenCalled();
  });

  // --- WAI-ARIA combobox/listbox pattern (a11y) ---
  // The value field is an autocomplete combobox: it must declare role="combobox"
  // (not a redundant role="textbox"), expose aria-expanded, link to the listbox
  // via aria-controls only while it is shown, and drive selection through
  // aria-activedescendant over real role="option" rows (no wrapping buttons).

  it("declares the value field as a combobox, not a textbox", () => {
    render(<FindByBar onAdd={() => {}} />);
    const input = screen.getByRole("combobox", { name: /value/i });
    expect(input.tagName).toBe("INPUT");
    // role="textbox" on a real <input> is redundant/discouraged; it must be gone.
    expect(input).not.toHaveAttribute("role", "textbox");
    // A combobox must expose its expanded state.
    expect(input).toHaveAttribute("aria-expanded");
  });

  it("exposes aria-expanded reflecting whether suggestions are shown", async () => {
    const user = userEvent.setup();
    useGroupBy.mockReturnValue(groupby(["anna@x.io"]));
    render(<FindByBar onAdd={() => {}} />);
    const input = screen.getByRole("combobox", { name: /value/i });
    // Collapsed before any value is typed.
    expect(input).toHaveAttribute("aria-expanded", "false");
    await user.type(input, "ann");
    await waitFor(() =>
      expect(input).toHaveAttribute("aria-expanded", "true"),
    );
  });

  it("associates the input with the listbox via aria-controls only while open", async () => {
    const user = userEvent.setup();
    useGroupBy.mockReturnValue(groupby(["anna@x.io"]));
    render(<FindByBar onAdd={() => {}} />);
    const input = screen.getByRole("combobox", { name: /value/i });
    // No dangling aria-controls before the listbox exists.
    expect(input).not.toHaveAttribute("aria-controls");
    await user.type(input, "ann");
    const list = await screen.findByRole("listbox");
    const listId = list.getAttribute("id");
    expect(listId).toBeTruthy();
    expect(input).toHaveAttribute("aria-controls", listId!);
  });

  it("renders suggestions as role=option rows with no wrapping buttons", async () => {
    const user = userEvent.setup();
    useGroupBy.mockReturnValue(groupby(["anna@x.io", "annie@x.io"]));
    render(<FindByBar onAdd={() => {}} />);
    await user.type(screen.getByRole("combobox", { name: /value/i }), "ann");

    const list = await screen.findByRole("listbox");
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(2);
    // Options must not wrap interactive buttons (that steals focus + breaks the
    // listbox interaction model). Only the Add submit button should exist.
    expect(within(list).queryByRole("button")).not.toBeInTheDocument();
  });

  it("tracks the highlighted option via aria-activedescendant and aria-selected", async () => {
    const user = userEvent.setup();
    useGroupBy.mockReturnValue(groupby(["anna@x.io", "annie@x.io"]));
    render(<FindByBar onAdd={() => {}} />);
    const input = screen.getByRole("combobox", { name: /value/i });
    await user.type(input, "ann");
    await screen.findByRole("listbox");

    // Nothing highlighted until the user navigates.
    expect(input).not.toHaveAttribute("aria-activedescendant");
    await user.keyboard("{ArrowDown}");

    const active = input.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    const list = screen.getByRole("listbox");
    const first = within(list).getByText("anna@x.io").closest("[role=option]");
    expect(first).toHaveAttribute("id", active!);
    expect(first).toHaveAttribute("aria-selected", "true");
    // The non-active option stays unselected (not hardcoded false everywhere,
    // but specifically false because it is not the active descendant).
    const second = within(list).getByText("annie@x.io").closest("[role=option]");
    expect(second).toHaveAttribute("aria-selected", "false");
  });

  it("selects the highlighted suggestion with ArrowDown + Enter", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    useGroupBy.mockReturnValue(groupby(["anna@x.io", "annie@x.io"]));
    render(<FindByBar onAdd={onAdd} />);
    await user.type(screen.getByRole("combobox", { name: /value/i }), "ann");
    await screen.findByRole("listbox");

    await user.keyboard("{ArrowDown}{Enter}");
    expect(onAdd).toHaveBeenCalledWith({ key: "userEmail", value: "anna@x.io" });
  });

  it("closes the listbox on Escape without emitting", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    useGroupBy.mockReturnValue(groupby(["anna@x.io"]));
    render(<FindByBar onAdd={onAdd} />);
    const input = screen.getByRole("combobox", { name: /value/i });
    await user.type(input, "ann");
    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(onAdd).not.toHaveBeenCalled();
  });
});
