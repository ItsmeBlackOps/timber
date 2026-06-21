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

  // ---- Eager-breadth cap (web-perf finding) --------------------------------
  // The depth budget keeps deep nodes collapsed, but a WIDE container at/under
  // the open depth used to mount every child eagerly (e.g. a 60-element array or
  // a 200-key object at depth 1). That can be 1000+ nodes on mount at the 64 KB
  // data cap. A large container must start collapsed regardless of depth so its
  // children are not in the DOM until the operator drills in.
  describe("eager-breadth cap", () => {
    it("collapses a wide array (>50 items) at a shallow depth by default", () => {
      // depth0 root object -> depth1 'big' array with 60 elements. Without the
      // breadth cap all 60 would mount eagerly (depth1 <= 2).
      const big = Array.from({ length: 60 }, (_, i) => `item-${i}`);
      render(<JsonTree value={{ big }} path="data" />);

      // The container header exists (so the operator can expand it)…
      expect(
        screen.getByRole("button", { name: /^big \(toggle\)$/i }),
      ).toBeInTheDocument();
      // …but its 60 children are NOT mounted (lazy until expanded).
      expect(screen.queryByText('"item-0"')).not.toBeInTheDocument();
      expect(screen.queryByText('"item-59"')).not.toBeInTheDocument();
    });

    it("collapses a wide object (>50 keys) at a shallow depth by default", () => {
      const meta: Record<string, number> = {};
      for (let i = 0; i < 200; i++) meta[`k${i}`] = i;
      render(<JsonTree value={{ meta }} path="data" />);

      expect(
        screen.getByRole("button", { name: /^meta \(toggle\)$/i }),
      ).toBeInTheDocument();
      // None of the 200 leaves should be mounted while collapsed.
      expect(screen.queryByText("k0")).not.toBeInTheDocument();
      expect(screen.queryByText("k199")).not.toBeInTheDocument();
    });

    it("still mounts a small container eagerly within the depth budget", () => {
      // A narrow object at depth1 must remain open (regression guard for the
      // cap — we only collapse WIDE containers, not all of them).
      render(<JsonTree value={{ small: { a: 1, b: 2 } }} path="data" />);
      expect(screen.getByText("a")).toBeInTheDocument();
      expect(screen.getByText("b")).toBeInTheDocument();
    });

    it("expands a capped wide container on click, revealing its children", async () => {
      const user = userEvent.setup();
      const big = Array.from({ length: 60 }, (_, i) => `item-${i}`);
      render(<JsonTree value={{ big }} path="data" />);

      await user.click(screen.getByRole("button", { name: /^big \(toggle\)$/i }));
      expect(screen.getByText('"item-0"')).toBeInTheDocument();
      expect(screen.getByText('"item-59"')).toBeInTheDocument();
    });

    it("caps total nodes mounted for a wide+deep payload", () => {
      // request.messages[60] + response.choices[60] + meta{200} — the finding's
      // worst case. With the cap, the wide containers stay collapsed so the
      // mounted node count is small (header rows only, not the contents).
      const messages = Array.from({ length: 60 }, (_, i) => ({ role: "user", text: `m${i}` }));
      const choices = Array.from({ length: 60 }, (_, i) => ({ index: i, text: `c${i}` }));
      const meta: Record<string, number> = {};
      for (let i = 0; i < 200; i++) meta[`k${i}`] = i;
      const doc = { request: { messages }, response: { choices }, meta };

      const { container } = render(<JsonTree value={doc} path="" />);
      const nodes = container.querySelectorAll("[data-json-node]");
      // Pre-fix this was ~327; the cap keeps it well under 100.
      expect(nodes.length).toBeLessThan(100);
    });
  });

  // ---- Contrast / a11y (web-a11y finding) ----------------------------------
  // Light-theme failures: string-value green (var(--tb-ok) #16A34A on white =
  // 3.30:1) and the search <mark> (text var(--tb-bg) on var(--tb-warn) =
  // 3.42:1) both fall below AA 4.5:1. The fix routes string values through a
  // dedicated contrast-safe token and gives <mark> its own token pair.
  describe("contrast-safe colors", () => {
    it("does not paint string values with the low-contrast var(--tb-ok)", () => {
      const { container } = render(<JsonTree value={{ s: "hello" }} path="data" />);
      const strSpan = screen.getByText('"hello"').closest("span")!;
      // Must not use the status-dot green that fails AA in light mode.
      expect(strSpan.getAttribute("style") ?? "").not.toMatch(/--tb-ok/);
      // It should use a dedicated string token instead.
      expect(strSpan.getAttribute("style") ?? "").toMatch(/--tb-string/);
      // sanity: there is exactly one string leaf here
      expect(container.querySelectorAll("[data-json-node]").length).toBeGreaterThan(0);
    });

    it("highlight <mark> does not rely on var(--tb-bg) text on var(--tb-warn)", () => {
      render(<JsonTree value={{ k: "needle-here" }} path="data" highlight="needle" />);
      const mark = document.querySelector("mark");
      expect(mark).not.toBeNull();
      const style = mark!.getAttribute("style") ?? "";
      // The failing light-theme combo was color:var(--tb-bg) on background:var(--tb-warn).
      expect(style).not.toMatch(/color:\s*var\(--tb-bg\)/);
      // It should use dedicated, theme-aware mark tokens.
      expect(style).toMatch(/--tb-mark-bg/);
      expect(style).toMatch(/--tb-mark-fg/);
    });
  });
});
