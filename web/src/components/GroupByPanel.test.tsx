import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { GroupByPanel } from "@/components/GroupByPanel";
import type { Filters } from "@/lib/filters";
import type { GroupByResponse } from "@/lib/types";

// GroupByPanel reads its bars from useGroupBy; mock it (contract C-F9).
const useGroupBy = vi.fn();
vi.mock("@/hooks/useGroupBy", () => ({
  useGroupBy: (...args: unknown[]) => useGroupBy(...args),
}));

const filters: Filters = { levels: [], ids: [], data: [] };

function resp(
  groups: GroupByResponse["groups"],
  otherCount = 0,
): { data: GroupByResponse; isLoading: boolean } {
  const total = groups.reduce((s, g) => s + g.count, 0) + otherCount;
  return { data: { by: "ids.userEmail", total, groups, otherCount }, isLoading: false };
}

beforeEach(() => {
  useGroupBy.mockReset();
});

describe("GroupByPanel", () => {
  it("calls useGroupBy with the `by` dimension and current filters", () => {
    useGroupBy.mockReturnValue(resp([]));
    render(<GroupByPanel by="ids.userEmail" filters={filters} onPick={() => {}} />);
    const call = useGroupBy.mock.calls.at(-1);
    expect(call?.[0]).toBe("ids.userEmail");
    expect(call?.[1]).toBe(filters);
  });

  it("renders one count bar per group with value + count", () => {
    useGroupBy.mockReturnValue(
      resp([
        { value: "anna@x.io", count: 42 },
        { value: "bob@x.io", count: 17 },
      ]),
    );
    render(<GroupByPanel by="ids.userEmail" filters={filters} onPick={() => {}} />);

    expect(screen.getByText("anna@x.io")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("bob@x.io")).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument();
  });

  it("shows otherCount when present", () => {
    useGroupBy.mockReturnValue(resp([{ value: "anna@x.io", count: 42 }], 9));
    render(<GroupByPanel by="ids.userEmail" filters={filters} onPick={() => {}} />);
    expect(screen.getByText(/other/i)).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
  });

  it("does not show the other row when otherCount is 0", () => {
    useGroupBy.mockReturnValue(resp([{ value: "anna@x.io", count: 42 }], 0));
    render(<GroupByPanel by="ids.userEmail" filters={filters} onPick={() => {}} />);
    expect(screen.queryByText(/other/i)).not.toBeInTheDocument();
  });

  it("calls onPick(value) when a bar is clicked", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    useGroupBy.mockReturnValue(
      resp([
        { value: "anna@x.io", count: 42 },
        { value: "bob@x.io", count: 17 },
      ]),
    );
    render(<GroupByPanel by="ids.userEmail" filters={filters} onPick={onPick} />);

    await user.click(screen.getByText("bob@x.io"));

    expect(onPick).toHaveBeenCalledWith("bob@x.io");
  });

  it("renders non-string values (numbers, booleans, null) as labels", () => {
    useGroupBy.mockReturnValue(
      resp([
        { value: 200, count: 5 },
        { value: true, count: 3 },
        { value: null, count: 1 },
      ]),
    );
    render(<GroupByPanel by="data.status" filters={filters} onPick={() => {}} />);

    expect(screen.getByText("200")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
    expect(screen.getByText(/null/i)).toBeInTheDocument();
  });

  it("shows an empty state when there are no groups", () => {
    useGroupBy.mockReturnValue(resp([]));
    render(<GroupByPanel by="ids.userEmail" filters={filters} onPick={() => {}} />);
    expect(screen.getByText(/no (results|data|values|matches)/i)).toBeInTheDocument();
  });
});
