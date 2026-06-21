import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdvancedFilters } from "@/components/AdvancedFilters";
import type { IdFilter, DataFilter } from "@/lib/filters";

type Change = { ids: IdFilter[]; data: DataFilter[] };

// AdvancedFilters' row inputs are controlled by props; multi-keystroke editing
// needs the props to update between keystrokes. Drive them through state and
// forward each emitted change to a spy.
function Controlled({
  ids: initialIds,
  data: initialData,
  onChange,
}: {
  ids: IdFilter[];
  data: DataFilter[];
  onChange: (c: Change) => void;
}) {
  const [state, setState] = useState<Change>({ ids: initialIds, data: initialData });
  return (
    <AdvancedFilters
      ids={state.ids}
      data={state.data}
      onChange={(c) => {
        setState(c);
        onChange(c);
      }}
    />
  );
}

describe("AdvancedFilters — id rows", () => {
  it("renders existing id rows with their key and value", () => {
    render(
      <AdvancedFilters
        ids={[{ key: "userEmail", value: "a@b.co" }]}
        data={[]}
        onChange={() => {}}
      />,
    );
    const rows = screen.getAllByTestId("id-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByLabelText(/id key/i)).toHaveValue("userEmail");
    expect(within(rows[0]).getByLabelText(/id value/i)).toHaveValue("a@b.co");
  });

  it("adds an empty id row when 'add id filter' is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AdvancedFilters ids={[]} data={[]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /add id filter/i }));
    const arg = onChange.mock.calls.at(-1)![0] as Change;
    expect(arg.ids).toEqual([{ key: "", value: "" }]);
  });

  it("edits an id row key", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled ids={[{ key: "", value: "" }]} data={[]} onChange={onChange} />);
    await user.type(screen.getByLabelText(/id key/i), "userId");
    const arg = onChange.mock.calls.at(-1)![0] as Change;
    expect(arg.ids[0].key).toBe("userId");
  });

  it("edits an id row value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Controlled ids={[{ key: "userId", value: "" }]} data={[]} onChange={onChange} />,
    );
    await user.type(screen.getByLabelText(/id value/i), "u_1");
    const arg = onChange.mock.calls.at(-1)![0] as Change;
    expect(arg.ids[0].value).toBe("u_1");
  });

  it("removes an id row", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AdvancedFilters
        ids={[
          { key: "userId", value: "u_1" },
          { key: "requestId", value: "r_2" },
        ]}
        data={[]}
        onChange={onChange}
      />,
    );
    const rows = screen.getAllByTestId("id-row");
    await user.click(
      within(rows[0]).getByRole("button", { name: /remove/i }),
    );
    const arg = onChange.mock.calls.at(-1)![0] as Change;
    expect(arg.ids).toEqual([{ key: "requestId", value: "r_2" }]);
  });
});

describe("AdvancedFilters — data rows", () => {
  it("renders existing data rows with path, op, value", () => {
    render(
      <AdvancedFilters
        ids={[]}
        data={[{ path: "latencyMs", op: "gte", value: "300" }]}
        onChange={() => {}}
      />,
    );
    const rows = screen.getAllByTestId("data-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByLabelText(/data path/i)).toHaveValue("latencyMs");
    expect(within(rows[0]).getByLabelText(/operator/i)).toHaveValue("gte");
    expect(within(rows[0]).getByLabelText(/data value/i)).toHaveValue("300");
  });

  it("adds an empty data row (default op 'eq') when 'add data filter' is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<AdvancedFilters ids={[]} data={[]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /add data filter/i }));
    const arg = onChange.mock.calls.at(-1)![0] as Change;
    expect(arg.data).toEqual([{ path: "", op: "eq", value: "" }]);
  });

  it("edits a data row operator", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AdvancedFilters
        ids={[]}
        data={[{ path: "latencyMs", op: "eq", value: "300" }]}
        onChange={onChange}
      />,
    );
    await user.selectOptions(screen.getByLabelText(/operator/i), "gte");
    const arg = onChange.mock.calls.at(-1)![0] as Change;
    expect(arg.data[0].op).toBe("gte");
  });

  it("edits a data row path and value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Controlled ids={[]} data={[{ path: "", op: "eq", value: "" }]} onChange={onChange} />,
    );
    await user.type(screen.getByLabelText(/data path/i), "status");
    await user.type(screen.getByLabelText(/data value/i), "500");
    const last = onChange.mock.calls.at(-1)![0] as Change;
    expect(last.data[0].path).toBe("status");
    expect(last.data[0].value).toBe("500");
  });

  it("removes a data row", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AdvancedFilters
        ids={[]}
        data={[
          { path: "latencyMs", op: "gte", value: "300" },
          { path: "status", op: "eq", value: "500" },
        ]}
        onChange={onChange}
      />,
    );
    const rows = screen.getAllByTestId("data-row");
    await user.click(
      within(rows[1]).getByRole("button", { name: /remove/i }),
    );
    const arg = onChange.mock.calls.at(-1)![0] as Change;
    expect(arg.data).toEqual([{ path: "latencyMs", op: "gte", value: "300" }]);
  });

  it("keeps id rows untouched when editing data rows (and vice versa)", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <AdvancedFilters
        ids={[{ key: "userId", value: "u_1" }]}
        data={[{ path: "status", op: "eq", value: "200" }]}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: /add data filter/i }));
    const arg = onChange.mock.calls.at(-1)![0] as Change;
    expect(arg.ids).toEqual([{ key: "userId", value: "u_1" }]);
  });
});
