import type { Settings } from "@/lib/settings";
import {
  DEFAULTS,
  loadSettings,
  saveSettings,
  isSameOriginBaseUrl,
} from "@/lib/settings";

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

// Identity + caching contract: loadSettings() is on the render hot path of the
// Explore/Stats routes and every data hook (via hooks/_shared.ts). It must hand
// back a referentially stable snapshot between actual changes and must not
// re-parse JSON on every call — otherwise downstream useMemo/useCallback caches
// (e.g. explore.tsx viewCfg → facetDims → onApplyLens) never hit.
describe("loadSettings caching / identity", () => {
  it("returns the same object reference across calls when storage is unchanged (empty)", () => {
    const a = loadSettings();
    const b = loadSettings();
    expect(b).toBe(a);
    expect(b.userKeys).toBe(a.userKeys);
  });

  it("returns the same object reference across calls when storage is unchanged (stored partial)", () => {
    localStorage.setItem(KEY, JSON.stringify({ readKey: "abc" }));
    const a = loadSettings();
    const b = loadSettings();
    expect(b).toBe(a);
  });

  it("keeps a stable userKeys array reference even when userKeys is persisted", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ userKeys: ["sessionId", "userId"] }),
    );
    const a = loadSettings();
    const b = loadSettings();
    expect(a.userKeys).toEqual(["sessionId", "userId"]);
    // The bug: JSON.parse minted a fresh array each call, so a.userKeys !== b.userKeys.
    expect(b.userKeys).toBe(a.userKeys);
  });

  it("does not re-parse storage on a cache hit", () => {
    localStorage.setItem(KEY, JSON.stringify({ readKey: "abc" }));
    loadSettings(); // prime the cache
    const parseSpy = vi.spyOn(JSON, "parse");
    loadSettings();
    loadSettings();
    expect(parseSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it("returns a fresh snapshot (new reference + new value) after saveSettings", () => {
    const before = loadSettings();
    const saved = saveSettings({ readKey: "k2" });
    const after = loadSettings();
    expect(after).not.toBe(before);
    expect(after.readKey).toBe("k2");
    expect(after).toEqual(saved);
  });

  it("reflects a value written directly to localStorage (cross-tab storage change)", () => {
    const before = loadSettings();
    expect(before.readKey).toBe("");
    localStorage.setItem(KEY, JSON.stringify({ readKey: "other-tab" }));
    const after = loadSettings();
    expect(after).not.toBe(before);
    expect(after.readKey).toBe("other-tab");
  });

  it("reflects clearing localStorage back to DEFAULTS with a new reference", () => {
    localStorage.setItem(KEY, JSON.stringify({ readKey: "abc" }));
    const stored = loadSettings();
    expect(stored.readKey).toBe("abc");
    localStorage.clear();
    const cleared = loadSettings();
    expect(cleared).not.toBe(stored);
    expect(cleared).toEqual(DEFAULTS);
  });
});

// SECURITY: apiBaseUrl gates an authenticated request carrying the read key.
// isSameOriginBaseUrl is the single source of truth for "may the key ride this
// base URL?" — used at save time (SettingsDialog) and conceptually mirrored at
// request time (api.ts). location.origin is http://localhost:3000 in jsdom.
describe("isSameOriginBaseUrl", () => {
  it("accepts the empty default (relative paths → same origin)", () => {
    expect(isSameOriginBaseUrl("")).toBe(true);
    expect(isSameOriginBaseUrl("   ")).toBe(true);
  });

  it("accepts an absolute URL on the current origin", () => {
    expect(isSameOriginBaseUrl("http://localhost:3000")).toBe(true);
    expect(isSameOriginBaseUrl("http://localhost:3000/")).toBe(true);
    expect(isSameOriginBaseUrl("http://localhost:3000/api")).toBe(true);
  });

  it("accepts a relative/path-only base URL (resolves to same origin)", () => {
    expect(isSameOriginBaseUrl("/api")).toBe(true);
    expect(isSameOriginBaseUrl("/v1")).toBe(true);
  });

  it("rejects a cross-origin host (the exfiltration vector)", () => {
    expect(isSameOriginBaseUrl("https://attacker.evil.example")).toBe(false);
    expect(isSameOriginBaseUrl("http://attacker.evil.example")).toBe(false);
    expect(isSameOriginBaseUrl("https://logs.example.com")).toBe(false);
  });

  it("rejects a different port / scheme on the same host", () => {
    expect(isSameOriginBaseUrl("http://localhost:7710")).toBe(false);
    expect(isSameOriginBaseUrl("https://localhost:3000")).toBe(false);
  });

  it("rejects a protocol-relative URL pointing off-origin", () => {
    expect(isSameOriginBaseUrl("//attacker.evil.example")).toBe(false);
  });

  it("fails closed on an unparseable absolute value", () => {
    // No host after the scheme → WHATWG URL throws → reject.
    expect(isSameOriginBaseUrl("http://")).toBe(false);
  });

  it("treats a schemeless token as a same-origin relative path (safe)", () => {
    // No valid scheme → parsed as a path relative to location.origin, so the
    // request can only stay on our origin and the key is safe to attach.
    expect(isSameOriginBaseUrl("ht!tp:nope")).toBe(true);
    expect(isSameOriginBaseUrl("not-a-url")).toBe(true);
  });
});
