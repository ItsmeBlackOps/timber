import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { JsonTree } from "@/components/JsonTree";
import type { PivotFragment } from "@/components/JsonTree";

// jsdom's navigator.clipboard is a read-only getter; define it with a spy.
function installClipboard() {
  const writeText = vi.fn<(text: string) => Promise<void>>(() =>
    Promise.resolve(),
  );
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

describe("JsonTree", () => {
  it("renders scalar leaves with their value", () => {
    render(<JsonTree value={42} path="data.count" />);
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("renders null distinctly", () => {
    render(<JsonTree value={null} path="data.x" />);
    expect(screen.getByText("null")).toBeInTheDocument();
  });

  it("renders an object's keys and values", () => {
    render(<JsonTree value={{ a: 1, b: "hi" }} path="data" />);
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByText('"hi"')).toBeInTheDocument();
  });

  it("renders array indices", () => {
    render(<JsonTree value={["x", "y"]} path="data.items" />);
    expect(screen.getByText('"x"')).toBeInTheDocument();
    expect(screen.getByText('"y"')).toBeInTheDocument();
  });

  it("collapses nodes deeper than depth 2 by default (lazy: children not in DOM)", () => {
    // depth0 root -> a(1) -> b(2) -> c(3, collapsed). "deepleaf" lives under c.
    const value = { a: { b: { c: { deepleaf: "SECRET" } } } };
    render(<JsonTree value={value} path="data" />);
    // a and b expanded by default; c is collapsed so its child is not rendered.
    expect(screen.getByText("a")).toBeInTheDocument();
    expect(screen.getByText("b")).toBeInTheDocument();
    expect(screen.getByText("c")).toBeInTheDocument();
    expect(screen.queryByText("deepleaf")).not.toBeInTheDocument();
    expect(screen.queryByText('"SECRET"')).not.toBeInTheDocument();
  });

  it("expands a collapsed node on click, revealing lazily-rendered children", async () => {
    const user = userEvent.setup();
    const value = { a: { b: { c: { deepleaf: "SECRET" } } } };
    render(<JsonTree value={value} path="data" />);

    // Toggle the collapsed "c" node open (the toggle is labeled "c (toggle)";
    // the sibling copy button is "Copy …" so this name is unambiguous).
    const cToggle = screen.getByRole("button", { name: /^c \(toggle\)$/i });
    await user.click(cToggle);

    expect(screen.getByText("deepleaf")).toBeInTheDocument();
    expect(screen.getByText('"SECRET"')).toBeInTheDocument();
  });

  it("collapses an expanded node on click (children leave the DOM)", async () => {
    const user = userEvent.setup();
    render(<JsonTree value={{ outer: { inner: 7 } }} path="data" />);
    expect(screen.getByText("inner")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^outer \(toggle\)$/i }));
    expect(screen.queryByText("inner")).not.toBeInTheDocument();
  });

  it("calls onPivot with a dotted data path + value for a leaf 'filter by this'", async () => {
    const user = userEvent.setup();
    const onPivot = vi.fn<(f: PivotFragment) => void>();
    render(
      <JsonTree
        value={{ response: { status: 500 } }}
        path="data"
        onPivot={onPivot}
      />,
    );
    // The leaf for status=500 should expose a pivot action.
    const pivotBtn = screen.getByRole("button", {
      name: /filter by this|pivot|data\.response\.status/i,
    });
    await user.click(pivotBtn);
    expect(onPivot).toHaveBeenCalledWith({
      kind: "data",
      path: "data.response.status",
      value: 500,
    });
  });

  it("derives kind:'ids' and strips the ids. prefix from the path", async () => {
    const user = userEvent.setup();
    const onPivot = vi.fn<(f: PivotFragment) => void>();
    render(
      <JsonTree value={{ userEmail: "a@b.com" }} path="ids" onPivot={onPivot} />,
    );
    await user.click(
      screen.getByRole("button", { name: /filter by this|pivot|userEmail/i }),
    );
    expect(onPivot).toHaveBeenCalledWith({
      kind: "ids",
      path: "userEmail",
      value: "a@b.com",
    });
  });

  it("does not render pivot actions when onPivot is not provided", () => {
    render(<JsonTree value={{ a: 1 }} path="data" />);
    expect(
      screen.queryByRole("button", { name: /filter by this|pivot/i }),
    ).not.toBeInTheDocument();
  });

  it("copies a subtree as JSON to the clipboard", async () => {
    // userEvent.setup() installs its own clipboard stub, so define ours AFTER it.
    const user = userEvent.setup();
    const writeText = installClipboard();
    render(<JsonTree value={{ a: { b: 1 } }} path="data" />);

    // The root object exposes a copy-subtree action labeled "Copy data".
    await user.click(screen.getByRole("button", { name: /^copy data$/i }));

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(JSON.parse(copied)).toEqual({ a: { b: 1 } });
  });

  it("clamps a long string and expands it on demand", async () => {
    const user = userEvent.setup();
    const long = "x".repeat(400);
    render(<JsonTree value={long} path="data.blob" />);

    // Full string not shown verbatim while clamped.
    expect(screen.queryByText(`"${long}"`)).not.toBeInTheDocument();
    // An expand affordance exists.
    const expandBtn = screen.getByRole("button", { name: /show more|expand|more/i });
    await user.click(expandBtn);
    expect(screen.getByText(`"${long}"`)).toBeInTheDocument();
  });

  it("renders a _truncated payload's _head plus a 'truncated (N bytes)' badge", () => {
    const value = {
      _truncated: true,
      _bytes: 20480,
      _head: '{"partial":"begin',
    };
    render(<JsonTree value={value} path="data" />);
    // The head content is visible.
    expect(screen.getByText(/partial.*begin/)).toBeInTheDocument();
    // A clear truncation badge mentioning the byte count.
    const badge = screen.getByText(/truncated/i);
    expect(badge).toBeInTheDocument();
    expect(badge.textContent ?? "").toMatch(/20480|20\.0 ?KB|20 ?KB/);
  });

  it("shows a count summary on collapsed containers", () => {
    // A deep, collapsed-by-default object should hint at its size.
    const value = { lvl1: { lvl2: { lvl3: { a: 1, b: 2, c: 3 } } } };
    render(<JsonTree value={value} path="data" />);
    const lvl3 = screen.getByRole("button", { name: /^lvl3 \(toggle\)$/i });
    // Collapsed container summary mentions item count (3 keys).
    expect(within(lvl3.closest("[data-json-node]")!).getByText(/3 items/)).toBeInTheDocument();
  });
});
