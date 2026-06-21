import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CodeBlock } from "@/components/CodeBlock";

// jsdom has no real clipboard; install a spy the same way DetailPanel's test does.
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

describe("CodeBlock", () => {
  it("renders the code text", () => {
    render(<CodeBlock code="curl -s $TIMBER_URL/v1/logs" />);
    expect(
      screen.getByText(/curl -s \$TIMBER_URL\/v1\/logs/),
    ).toBeInTheDocument();
  });

  it("exposes the code in a <pre>/<code> block for readable formatting", () => {
    const { container } = render(<CodeBlock code={"line1\nline2"} />);
    const pre = container.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre).toHaveTextContent("line1");
    expect(pre).toHaveTextContent("line2");
  });

  it("reflects the language as a data attribute when provided", () => {
    const { container } = render(<CodeBlock code="print(1)" lang="python" />);
    const el = container.querySelector('[data-lang="python"]');
    expect(el).not.toBeNull();
  });

  it("copies the code to the clipboard when the copy button is clicked", async () => {
    const user = userEvent.setup();
    const writeText = installClipboard();
    const code = "curl -s $TIMBER_URL/v1/stats";
    render(<CodeBlock code={code} />);

    await user.click(screen.getByRole("button", { name: /copy/i }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toBe(code);
  });

  it("shows a transient 'copied' confirmation after copying", async () => {
    const user = userEvent.setup();
    installClipboard();
    render(<CodeBlock code="echo hi" />);

    const button = screen.getByRole("button", { name: /copy/i });
    await user.click(button);

    // Button label/aria flips to a copied state so the user gets feedback.
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });
});
