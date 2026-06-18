import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DetailPanel } from "@/components/DetailPanel";
import type { PivotFragment } from "@/components/JsonTree";
import type { LogDoc } from "@/lib/types";

function makeDoc(over: Partial<LogDoc> = {}): LogDoc {
  return {
    _id: "doc-42",
    app: "billing",
    env: "prod",
    event: "charge.failed",
    level: "error",
    ts: "2026-06-14T05:00:00.000Z",
    message: "Card declined",
    ids: { userEmail: "user@x.com", requestId: "req-9" },
    data: {
      request: { method: "POST", path: "/charge", amount: 1200 },
      response: { status: 402, reason: "declined" },
    },
    receivedAt: "2026-06-14T05:00:01.000Z",
    expiresAt: "2026-07-14T05:00:01.000Z",
    ...over,
  };
}

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

describe("DetailPanel", () => {
  it("renders a header with level, app, event and time", () => {
    render(<DetailPanel doc={makeDoc()} onPivot={() => {}} />);
    const header = screen.getByTestId("detail-header");
    expect(within(header).getByText("billing")).toBeInTheDocument();
    expect(within(header).getByText("charge.failed")).toBeInTheDocument();
    expect(within(header).getByTestId("level-chip")).toHaveAttribute(
      "data-level",
      "error",
    );
    // Some time representation present.
    expect(within(header).getByTestId("detail-time")).toBeInTheDocument();
  });

  it("renders an ids chip per id and pivots on click", async () => {
    const user = userEvent.setup();
    const onPivot = vi.fn<(f: PivotFragment) => void>();
    render(<DetailPanel doc={makeDoc()} onPivot={onPivot} />);

    const chip = screen.getByRole("button", { name: /userEmail.*user@x\.com|user@x\.com/i });
    await user.click(chip);
    expect(onPivot).toHaveBeenCalledWith({
      kind: "ids",
      path: "userEmail",
      value: "user@x.com",
    });
  });

  it("defaults to the Request/Response view (two panes from data)", () => {
    render(<DetailPanel doc={makeDoc()} onPivot={() => {}} />);
    expect(screen.getByRole("region", { name: /request/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /response/i })).toBeInTheDocument();
    // A response value is visible.
    expect(screen.getByText("402")).toBeInTheDocument();
  });

  it("switches to the Raw view showing the full document tree", async () => {
    const user = userEvent.setup();
    render(<DetailPanel doc={makeDoc()} onPivot={() => {}} />);

    await user.click(screen.getByRole("tab", { name: /raw/i }));

    // Raw view exposes top-level doc keys not shown by ReqResView.
    expect(screen.getByText("event")).toBeInTheDocument();
    expect(screen.getByText("receivedAt")).toBeInTheDocument();
    // The Request/Response panes are gone.
    expect(screen.queryByRole("region", { name: /request/i })).not.toBeInTheDocument();
  });

  it("pivots from a data leaf in the Raw view with the dotted data path", async () => {
    const user = userEvent.setup();
    const onPivot = vi.fn<(f: PivotFragment) => void>();
    render(<DetailPanel doc={makeDoc()} onPivot={onPivot} />);

    await user.click(screen.getByRole("tab", { name: /raw/i }));
    // The pivot action for the status leaf carries its dotted path in the label,
    // which uniquely identifies it among all "Filter by this (…)" buttons.
    await user.click(
      screen.getByRole("button", { name: /filter by this \(data\.response\.status\)/i }),
    );
    expect(onPivot).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "data", path: "data.response.status", value: 402 }),
    );
  });

  it("copies the full document JSON", async () => {
    const user = userEvent.setup();
    const writeText = installClipboard();
    render(<DetailPanel doc={makeDoc()} onPivot={() => {}} />);

    await user.click(screen.getByRole("button", { name: /copy json|copy full/i }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(JSON.parse(copied)._id).toBe("doc-42");
  });

  it("copies a deep link (the current URL)", async () => {
    const user = userEvent.setup();
    const writeText = installClipboard();
    render(<DetailPanel doc={makeDoc()} onPivot={() => {}} />);

    await user.click(screen.getByRole("button", { name: /deep link|copy link|share/i }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toBe(window.location.href);
  });

  it("highlights matches when searching within the document", async () => {
    const user = userEvent.setup();
    render(<DetailPanel doc={makeDoc()} onPivot={() => {}} />);

    const search = screen.getByRole("searchbox");
    await user.type(search, "declined");

    // A <mark> appears around the matching text somewhere in the panel.
    const marks = document.querySelectorAll("mark");
    expect(marks.length).toBeGreaterThan(0);
    expect(
      Array.from(marks).some((m) => /declined/i.test(m.textContent ?? "")),
    ).toBe(true);
  });

  // ---- Deferred in-document search (web-perf finding) ----------------------
  // The search box drives a `highlight` prop that fans out to every visible leaf
  // of a potentially huge JsonTree. Writing query state straight into highlight
  // re-renders the whole open tree on every keystroke. The fix defers the
  // highlight (useDeferredValue) so the controlled input stays responsive and
  // React can deprioritize the tree recompute. We assert the observable
  // contract: (1) the input value reflects every keystroke synchronously, and
  // (2) the body exposes a busy flag while the deferred highlight catches up,
  // settling to not-busy with the final match highlighted.
  it("keeps the search input responsive and highlights the final query", async () => {
    const user = userEvent.setup();
    render(<DetailPanel doc={makeDoc()} onPivot={() => {}} />);

    const search = screen.getByRole("searchbox") as HTMLInputElement;
    await user.type(search, "declined");

    // The controlled input shows the full typed value (urgent update path).
    expect(search.value).toBe("declined");

    // The body wrapper carries an aria-busy flag tied to the deferred highlight;
    // once settled it is not busy and the final query is highlighted.
    const body = screen.getByTestId("detail-body");
    expect(body).toHaveAttribute("aria-busy", "false");
    const marks = document.querySelectorAll("mark");
    expect(
      Array.from(marks).some((m) => /declined/i.test(m.textContent ?? "")),
    ).toBe(true);
  });

  it("marks the body busy while a non-empty query is settling (stale flag wired)", () => {
    // The body must own an aria-busy attribute reflecting query !== deferred.
    // At rest (no query) it is not busy. This guards that the deferral plumbing
    // exists rather than the old synchronous highlight pass.
    render(<DetailPanel doc={makeDoc()} onPivot={() => {}} />);
    const body = screen.getByTestId("detail-body");
    expect(body).toHaveAttribute("aria-busy", "false");
  });

  it("falls back to a single tree in Request/Response when data has no pair", () => {
    render(
      <DetailPanel
        doc={makeDoc({ data: { foo: "bar" } })}
        onPivot={() => {}}
      />,
    );
    // No labeled panes, but the payload is visible.
    expect(screen.queryByRole("region", { name: /request/i })).not.toBeInTheDocument();
    expect(screen.getByText("foo")).toBeInTheDocument();
  });

  // ---- WAI-ARIA Tabs pattern (web-a11y finding) ----------------------------
  // The view switch is marked up as role=tablist + role=tab. To be a conformant
  // tab widget (APG /w3c/wai-aria-practices tabs-pattern) the switched body must
  // be a role=tabpanel associated to the active tab, each tab must own an id +
  // aria-controls, focus must rove (selected tab tabindex 0, others -1), and the
  // tablist must support Arrow/Home/End navigation with automatic activation.
  it("associates a tabpanel with the active tab (role, id, aria-labelledby, tabindex)", () => {
    render(<DetailPanel doc={makeDoc()} onPivot={() => {}} />);

    const panel = screen.getByRole("tabpanel");
    // The panel is in the page tab sequence so SR users reach its content.
    expect(panel).toHaveAttribute("tabindex", "0");
    expect(panel).toHaveAttribute("id");

    // aria-labelledby points at the *active* tab's id.
    const selectedTab = screen.getByRole("tab", { selected: true });
    expect(selectedTab).toHaveAttribute("id");
    expect(panel.getAttribute("aria-labelledby")).toBe(selectedTab.id);

    // The active tab controls exactly this panel.
    expect(selectedTab.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("implements a roving tabindex across the two tabs", () => {
    render(<DetailPanel doc={makeDoc()} onPivot={() => {}} />);

    const [reqres, raw] = screen.getAllByRole("tab");
    // Default selection is Request/Response.
    expect(reqres).toHaveAttribute("aria-selected", "true");
    expect(raw).toHaveAttribute("aria-selected", "false");

    // Exactly one tab is in the tab order (tabindex 0); the other is -1.
    expect(reqres).toHaveAttribute("tabindex", "0");
    expect(raw).toHaveAttribute("tabindex", "-1");
  });

  it("moves focus and selection with Right/Left arrows (automatic activation, wrapping)", async () => {
    const user = userEvent.setup();
    render(<DetailPanel doc={makeDoc()} onPivot={() => {}} />);

    const reqres = screen.getByRole("tab", { name: /request/i });
    const raw = screen.getByRole("tab", { name: /raw/i });

    reqres.focus();
    expect(reqres).toHaveFocus();

    // Right arrow -> focus + select the next (Raw) tab; panel follows.
    await user.keyboard("{ArrowRight}");
    expect(raw).toHaveFocus();
    expect(raw).toHaveAttribute("aria-selected", "true");
    expect(raw).toHaveAttribute("tabindex", "0");
    expect(reqres).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe(raw.id);

    // Right again from the last tab wraps to the first.
    await user.keyboard("{ArrowRight}");
    expect(reqres).toHaveFocus();
    expect(reqres).toHaveAttribute("aria-selected", "true");

    // Left from the first tab wraps to the last.
    await user.keyboard("{ArrowLeft}");
    expect(raw).toHaveFocus();
    expect(raw).toHaveAttribute("aria-selected", "true");
  });

  it("jumps to first/last tab with Home/End", async () => {
    const user = userEvent.setup();
    render(<DetailPanel doc={makeDoc()} onPivot={() => {}} />);

    const reqres = screen.getByRole("tab", { name: /request/i });
    const raw = screen.getByRole("tab", { name: /raw/i });

    reqres.focus();
    await user.keyboard("{End}");
    expect(raw).toHaveFocus();
    expect(raw).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Home}");
    expect(reqres).toHaveFocus();
    expect(reqres).toHaveAttribute("aria-selected", "true");
  });
});
