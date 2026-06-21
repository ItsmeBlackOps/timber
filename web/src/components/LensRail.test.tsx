import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LensRail } from "@/components/LensRail";
import { BUILTIN_LENSES } from "@/lib/views";
import type { SavedView } from "@/lib/views";

function noop() {}

const baseProps = {
  active: undefined,
  onApplyLens: noop,
  savedViews: [] as SavedView[],
  onApplySaved: noop,
  onSaveCurrent: noop,
  onDeleteSaved: noop,
};

describe("LensRail", () => {
  it("lists every built-in lens by its label", () => {
    render(<LensRail {...baseProps} />);
    for (const lens of BUILTIN_LENSES) {
      expect(screen.getByText(lens.label)).toBeInTheDocument();
    }
  });

  it("calls onApplyLens with the lens object when a lens is clicked", async () => {
    const user = userEvent.setup();
    const onApplyLens = vi.fn();
    render(<LensRail {...baseProps} onApplyLens={onApplyLens} />);

    await user.click(screen.getByText("Errors & warnings"));

    expect(onApplyLens).toHaveBeenCalledTimes(1);
    expect(onApplyLens.mock.calls[0][0]).toMatchObject({ id: "errors" });
  });

  it("marks the active lens (aria-pressed/aria-current)", () => {
    const errors = BUILTIN_LENSES.find((l) => l.id === "errors")!;
    render(<LensRail {...baseProps} active={errors.id} />);
    const btn = screen.getByRole("button", { name: new RegExp(errors.label, "i") });
    const pressed =
      btn.getAttribute("aria-pressed") === "true" ||
      btn.getAttribute("aria-current") === "true";
    expect(pressed).toBe(true);
  });

  it("renders saved views and applies one on click", async () => {
    const user = userEvent.setup();
    const onApplySaved = vi.fn();
    const savedViews: SavedView[] = [
      { id: "v1", name: "My errors", params: "level=error" },
      { id: "v2", name: "Acme org", params: "ids.orgId=acme" },
    ];
    render(
      <LensRail {...baseProps} savedViews={savedViews} onApplySaved={onApplySaved} />,
    );

    expect(screen.getByText("My errors")).toBeInTheDocument();
    await user.click(screen.getByText("Acme org"));

    expect(onApplySaved).toHaveBeenCalledTimes(1);
    expect(onApplySaved.mock.calls[0][0]).toMatchObject({ id: "v2" });
  });

  it("saves the current view with a typed name via onSaveCurrent", async () => {
    const user = userEvent.setup();
    const onSaveCurrent = vi.fn();
    render(<LensRail {...baseProps} onSaveCurrent={onSaveCurrent} />);

    await user.click(screen.getByRole("button", { name: /save/i }));
    await user.type(
      screen.getByRole("textbox", { name: /name|view/i }),
      "Prod errors",
    );
    // submit the new-view form (Enter or a confirm button)
    await user.keyboard("{Enter}");

    expect(onSaveCurrent).toHaveBeenCalledWith("Prod errors");
  });

  it("deletes a saved view via onDeleteSaved", async () => {
    const user = userEvent.setup();
    const onDeleteSaved = vi.fn();
    const savedViews: SavedView[] = [
      { id: "v1", name: "My errors", params: "level=error" },
    ];
    render(
      <LensRail {...baseProps} savedViews={savedViews} onDeleteSaved={onDeleteSaved} />,
    );

    // the delete control is scoped to the saved-view's row
    const row = screen.getByText("My errors").closest("li") ?? document.body;
    await user.click(within(row).getByRole("button", { name: /delete|remove/i }));

    expect(onDeleteSaved).toHaveBeenCalledWith("v1");
  });

  it("does not call onSaveCurrent for a blank name", async () => {
    const user = userEvent.setup();
    const onSaveCurrent = vi.fn();
    render(<LensRail {...baseProps} onSaveCurrent={onSaveCurrent} />);

    await user.click(screen.getByRole("button", { name: /save/i }));
    await user.keyboard("{Enter}");

    expect(onSaveCurrent).not.toHaveBeenCalled();
  });
});
