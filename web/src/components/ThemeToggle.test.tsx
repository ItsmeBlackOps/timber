import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
});
