import { render, screen, waitFor } from "@testing-library/react";
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

    await user.type(screen.getByRole("textbox", { name: /value/i }), "ann");

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

    await user.type(screen.getByRole("textbox", { name: /value/i }), "ann");

    expect(await screen.findByText("anna@x.io")).toBeInTheDocument();
    expect(screen.getByText("annie@x.io")).toBeInTheDocument();
  });

  it("emits ids.<key>=value via onAdd when a suggestion is clicked", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    useGroupBy.mockReturnValue(groupby(["anna@x.io"]));
    render(<FindByBar onAdd={onAdd} />);

    await user.type(screen.getByRole("textbox", { name: /value/i }), "ann");
    await user.click(await screen.findByText("anna@x.io"));

    expect(onAdd).toHaveBeenCalledWith({ key: "userEmail", value: "anna@x.io" });
  });

  it("emits the typed value on Enter / Add even without picking a suggestion", async () => {
    const user = userEvent.setup();
    const onAdd = vi.fn();
    render(<FindByBar onAdd={onAdd} />);

    const input = screen.getByRole("textbox", { name: /value/i });
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
    await user.type(screen.getByRole("textbox", { name: /value/i }), "acme");
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
});
