import type { Settings } from "@/lib/settings";
import { DEFAULTS, loadSettings, saveSettings } from "@/lib/settings";

const KEY = "timber.settings";

beforeEach(() => {
  localStorage.clear();
});

describe("DEFAULTS", () => {
  it("matches the C-F5 contract", () => {
    expect(DEFAULTS).toEqual({
      apiBaseUrl: "",
      readKey: "",
      theme: "system",
      tailIntervalMs: 2000,
      userKeys: ["userEmail", "userId"],
      slowMs: 300,
    } satisfies Settings);
  });
});

describe("loadSettings", () => {
  it("returns DEFAULTS when nothing is stored", () => {
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("merges stored partial over DEFAULTS", () => {
    localStorage.setItem(KEY, JSON.stringify({ readKey: "abc", slowMs: 999 }));
    const s = loadSettings();
    expect(s.readKey).toBe("abc");
    expect(s.slowMs).toBe(999);
    // untouched fields fall back to defaults
    expect(s.tailIntervalMs).toBe(2000);
    expect(s.userKeys).toEqual(["userEmail", "userId"]);
    expect(s.theme).toBe("system");
  });

  it("tolerates corrupt JSON and returns DEFAULTS", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("ignores non-object stored values", () => {
    localStorage.setItem(KEY, JSON.stringify("a string"));
    expect(loadSettings()).toEqual(DEFAULTS);
  });
});

describe("saveSettings", () => {
  it("merges partial over current and persists to localStorage", () => {
    const result = saveSettings({ readKey: "k1" });
    expect(result.readKey).toBe("k1");
    expect(result.theme).toBe("system");
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.readKey).toBe("k1");
  });

  it("returns the full merged Settings object", () => {
    const result = saveSettings({ theme: "dark" });
    expect(result).toEqual({ ...DEFAULTS, theme: "dark" });
  });

  it("accumulates across multiple saves", () => {
    saveSettings({ readKey: "k1" });
    const result = saveSettings({ apiBaseUrl: "http://x" });
    expect(result.readKey).toBe("k1");
    expect(result.apiBaseUrl).toBe("http://x");
    expect(loadSettings()).toEqual(result);
  });

  it("emits a 'timber:settings' event on save", () => {
    const handler = vi.fn();
    window.addEventListener("timber:settings", handler);
    saveSettings({ readKey: "evt" });
    expect(handler).toHaveBeenCalledTimes(1);
    window.removeEventListener("timber:settings", handler);
  });
});
