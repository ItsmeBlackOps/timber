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
});
