import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LevelChips } from "@/components/LevelChips";
import type { Level } from "@/lib/types";

describe("LevelChips", () => {
  it("renders a chip per level", () => {
    render(<LevelChips value={[]} onChange={() => {}} />);
    for (const lvl of ["debug", "info", "warn", "error"]) {
      expect(
        screen.getByRole("button", { name: new RegExp(lvl, "i") }),
      ).toBeInTheDocument();
    }
  });

  it("marks selected levels as pressed and unselected as not pressed", () => {
    render(<LevelChips value={["error", "warn"]} onChange={() => {}} />);
    expect(
      screen.getByRole("button", { name: /error/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /warn/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /info/i }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: /debug/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("adds a level when an unselected chip is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LevelChips value={["error"]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /warn/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Level[];
    expect(new Set(next)).toEqual(new Set<Level>(["error", "warn"]));
  });

  it("removes a level when a selected chip is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LevelChips value={["error", "warn"]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /error/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual(["warn"]);
  });
});
