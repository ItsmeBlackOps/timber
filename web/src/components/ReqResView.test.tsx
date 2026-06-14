import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReqResView } from "@/components/ReqResView";
import type { PivotFragment } from "@/components/JsonTree";

/** Find the labeled pane region whose accessible name matches. */
function pane(name: RegExp) {
  return screen.getByRole("region", { name });
}

describe("ReqResView", () => {
  it("renders a two-pane Request | Response view for {request, response}", () => {
    render(
      <ReqResView
        data={{
          request: { method: "POST", url: "/charge" },
          response: { status: 200 },
        }}
      />,
    );
    const req = pane(/request/i);
    const res = pane(/response/i);
    expect(req).toBeInTheDocument();
    expect(res).toBeInTheDocument();
    // Each pane contains its own values.
    expect(within(req).getByText('"POST"')).toBeInTheDocument();
    expect(within(res).getByText("200")).toBeInTheDocument();
  });

  it("detects the req/res shorthand pair", () => {
    render(<ReqResView data={{ req: { a: 1 }, res: { b: 2 } }} />);
    expect(within(pane(/request/i)).getByText("1")).toBeInTheDocument();
    expect(within(pane(/response/i)).getByText("2")).toBeInTheDocument();
  });

  it("detects the prompt/completion (LLM) pair", () => {
    render(
      <ReqResView
        data={{ prompt: "say hi", completion: "hi there", model: "gpt" }}
      />,
    );
    expect(within(pane(/request|prompt/i)).getByText(/say hi/)).toBeInTheDocument();
    expect(
      within(pane(/response|completion/i)).getByText(/hi there/),
    ).toBeInTheDocument();
  });

  it("detects the input/output pair", () => {
    render(<ReqResView data={{ input: { q: "x" }, output: { a: "y" } }} />);
    expect(within(pane(/request|input/i)).getByText('"x"')).toBeInTheDocument();
    expect(within(pane(/response|output/i)).getByText('"y"')).toBeInTheDocument();
  });

  it("detects the messages/output pair", () => {
    render(
      <ReqResView
        data={{ messages: [{ role: "user", content: "hello" }], output: "ok" }}
      />,
    );
    expect(within(pane(/request|messages/i)).getByText(/hello/)).toBeInTheDocument();
    expect(within(pane(/response|output/i)).getByText(/ok/)).toBeInTheDocument();
  });

  it("falls back to a single tree when no request/response pair is present", () => {
    render(<ReqResView data={{ foo: 1, bar: 2 }} />);
    // No labeled Request/Response panes.
    expect(screen.queryByRole("region", { name: /request/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /response/i })).not.toBeInTheDocument();
    // But the data is still shown via a JsonTree.
    expect(screen.getByText("foo")).toBeInTheDocument();
    expect(screen.getByText("bar")).toBeInTheDocument();
  });

  it("parses a JSON-looking string value and pretty-prints it as a tree", () => {
    render(
      <ReqResView
        data={{
          request: '{"nested":{"k":"v"}}',
          response: { ok: true },
        }}
      />,
    );
    const req = pane(/request/i);
    // Parsed: the nested key/value become tree nodes, not one raw string blob.
    expect(within(req).getByText("nested")).toBeInTheDocument();
    expect(within(req).getByText("k")).toBeInTheDocument();
    expect(within(req).getByText('"v"')).toBeInTheDocument();
  });

  it("shows multiline plain-text in a <pre> block", () => {
    const text = "line one\nline two\nline three";
    render(<ReqResView data={{ prompt: text, completion: "done" }} />);
    const req = pane(/request|prompt/i);
    const pre = within(req).getByText(/line one/);
    expect(pre.tagName.toLowerCase()).toBe("pre");
    expect(pre.textContent).toContain("line two");
  });

  it("threads onPivot through to the panes' leaves", async () => {
    const user = userEvent.setup();
    const onPivot = vi.fn<(f: PivotFragment) => void>();
    render(
      <ReqResView
        data={{ request: { status: 500 }, response: { ok: false } }}
        onPivot={onPivot}
      />,
    );
    const req = pane(/request/i);
    const pivot = within(req).getByRole("button", {
      name: /filter by this|pivot|status/i,
    });
    await user.click(pivot);
    expect(onPivot).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "data", value: 500 }),
    );
  });
});
