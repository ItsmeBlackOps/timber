import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { loadSettings } from "@/lib/settings";

// jsdom lacks matchMedia; applyTheme() resolves "system" through it.
function installMatchMedia(prefersDark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => ({
      matches: prefersDark,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  installMatchMedia(false); // system => light by default
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThemeToggle", () => {
  it("renders a button (accessible name mentions theme)", () => {
    render(<ThemeToggle />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveAccessibleName(/theme|dark|light/i);
  });

  it("applies the persisted theme to <html data-theme> on mount", () => {
    localStorage.setItem(
      "timber.settings",
      JSON.stringify({ theme: "dark" }),
    );
    render(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("flips data-theme from light to dark on click and persists", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />); // starts at system => light
    expect(document.documentElement.dataset.theme).toBe("light");

    await user.click(screen.getByRole("button"));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(loadSettings().theme).toBe("dark");
  });

  it("flips data-theme from dark back to light on a second click and persists", async () => {
    const user = userEvent.setup();
    localStorage.setItem(
      "timber.settings",
      JSON.stringify({ theme: "dark" }),
    );
    render(<ThemeToggle />);
    expect(document.documentElement.dataset.theme).toBe("dark");

    await user.click(screen.getByRole("button"));

    expect(document.documentElement.dataset.theme).toBe("light");
    expect(loadSettings().theme).toBe("light");
  });

  // Regression for the react-hooks/set-state-in-effect finding: the mount
  // effect must apply the theme to the DOM as a pure side effect, without
  // issuing a state update. The useState initializer already resolves the same
  // concrete theme, so a setState in the effect would be a redundant update. We
  // assert no *update*-phase commit is produced by mounting (only the initial
  // mount commit), which locks the effect to "apply DOM only, never setState".
  it("does not trigger an update-phase commit from the mount effect", () => {
    localStorage.setItem(
      "timber.settings",
      JSON.stringify({ theme: "dark" }),
    );
    const phases: string[] = [];
    render(
      <Profiler
        id="theme-toggle"
        onRender={(_id, phase) => phases.push(phase)}
      >
        <ThemeToggle />
      </Profiler>,
    );

    // Exactly one mount commit; the effect applies the DOM but issues no
    // state update, so there is no follow-up "update" commit. (A "nested-update"
    // phase, if React reports one, would equally signal the redundant setState.)
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(phases).toEqual(["mount"]);
  });
});
