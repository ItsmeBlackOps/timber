import type { ThemeChoice } from "@/lib/theme";
import { applyTheme, resolveTheme, watchSystemTheme } from "@/lib/theme";

// jsdom has no matchMedia; install a controllable stub.
type MqlListener = (e: { matches: boolean }) => void;
interface FakeMql {
  matches: boolean;
  media: string;
  listeners: Set<MqlListener>;
  addEventListener: (t: string, cb: MqlListener) => void;
  removeEventListener: (t: string, cb: MqlListener) => void;
}

let fakeMql: FakeMql;

function installMatchMedia(prefersDark: boolean) {
  fakeMql = {
    matches: prefersDark,
    media: "(prefers-color-scheme: dark)",
    listeners: new Set(),
    addEventListener: (_t, cb) => fakeMql.listeners.add(cb),
    removeEventListener: (_t, cb) => fakeMql.listeners.delete(cb),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => {
      fakeMql.media = q;
      return fakeMql;
    }),
  );
}

function fireSystemChange(prefersDark: boolean) {
  fakeMql.matches = prefersDark;
  for (const cb of fakeMql.listeners) cb({ matches: prefersDark });
}

beforeEach(() => {
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveTheme", () => {
  it("returns the concrete choice unchanged for light/dark", () => {
    installMatchMedia(true);
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("resolves 'system' to 'dark' when OS prefers dark", () => {
    installMatchMedia(true);
    expect(resolveTheme("system")).toBe("dark");
  });

  it("resolves 'system' to 'light' when OS prefers light", () => {
    installMatchMedia(false);
    expect(resolveTheme("system")).toBe("light");
  });
});

describe("applyTheme", () => {
  it("sets data-theme=dark for explicit 'dark'", () => {
    installMatchMedia(false);
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("sets data-theme=light for explicit 'light'", () => {
    installMatchMedia(true);
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("resolves 'system' via matchMedia (dark)", () => {
    installMatchMedia(true);
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("resolves 'system' via matchMedia (light)", () => {
    installMatchMedia(false);
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("returns the resolved concrete theme", () => {
    installMatchMedia(true);
    const r: "light" | "dark" = applyTheme("system");
    expect(r).toBe("dark");
  });
});

describe("watchSystemTheme", () => {
  it("re-applies when the OS preference changes while in 'system' mode", () => {
    installMatchMedia(false);
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBe("light");

    const stop = watchSystemTheme(() => "system");
    fireSystemChange(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    stop();
  });

  it("does NOT override an explicit choice when the OS changes", () => {
    installMatchMedia(false);
    applyTheme("dark");
    const stop = watchSystemTheme(() => "dark" as ThemeChoice);
    fireSystemChange(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    stop();
  });

  it("returns an unsubscribe that detaches the listener", () => {
    installMatchMedia(false);
    const stop = watchSystemTheme(() => "system");
    expect(fakeMql.listeners.size).toBe(1);
    stop();
    expect(fakeMql.listeners.size).toBe(0);
  });
});
