// C-F5 — persisted console settings (localStorage), merged over DEFAULTS.

export interface Settings {
  apiBaseUrl: string;
  readKey: string;
  theme: "system" | "light" | "dark";
  tailIntervalMs: number;
  userKeys: string[];
  slowMs: number;
}

export const DEFAULTS: Settings = {
  apiBaseUrl: "",
  readKey: "",
  theme: "system",
  tailIntervalMs: 2000,
  userKeys: ["userEmail", "userId"],
  slowMs: 300,
};

const STORAGE_KEY = "timber.settings";
const EVENT = "timber:settings";

/**
 * SECURITY (read-key exfiltration / SSRF-to-wrong-origin): `apiBaseUrl` is
 * operator-settable free text and gates an authenticated request that carries
 * the high-value read key. A base URL is only "safe" when it keeps requests on
 * the current origin, so the Bearer key can never be transmitted to a foreign
 * host (whether apiBaseUrl was set via the Settings UI or, in future, populated
 * from an untrusted source like a URL param, an imported view, or postMessage).
 *
 * Safe iff: empty (same-origin, the default), or a value that resolves —
 * relative or absolute — to exactly `location.origin`. Anything that parses to a
 * different origin, or that won't parse at all, is rejected. The split-origin
 * deployment documented in the spec still works by fronting the API with a
 * same-origin proxy (the server adds no CORS), which is the intended path.
 */
export function isSameOriginBaseUrl(apiBaseUrl: string): boolean {
  const trimmed = apiBaseUrl.trim();
  if (trimmed === "") return true; // default: relative paths → same origin
  try {
    return new URL(trimmed, location.origin).origin === location.origin;
  } catch {
    return false; // unparseable base URL → not safe
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSettings(raw: string | null): Settings {
  if (raw === null) return { ...DEFAULTS };
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    return { ...DEFAULTS };
  }
  if (!isRecord(stored)) return { ...DEFAULTS };
  return { ...DEFAULTS, ...stored };
}

// Snapshot cache. loadSettings() is on the render hot path of the Explore/Stats
// routes and every data hook (hooks/_shared.ts), so it must NOT re-parse JSON or
// allocate a fresh object/array on every call — that referential churn defeats
// the downstream useMemo/useCallback caches that depend on `settings.userKeys`.
// We key the cache on the exact raw string last read from storage: while it's
// unchanged we hand back the same frozen-identity object (no parse, no alloc);
// when storage changes (this tab's saveSettings, or another tab via the native
// `storage` event, or a test clearing localStorage) the raw differs and we
// reparse once. A sentinel distinguishes "never read" from a cached `null` raw.
const UNREAD = Symbol("unread");
let cachedRaw: string | null | typeof UNREAD = UNREAD;
let cachedValue: Settings = DEFAULTS;

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // storage may be unavailable (private mode / sandbox); treat as unset.
    return null;
  }
}

/**
 * Load settings, merging any stored partial over DEFAULTS. Corrupt/missing →
 * DEFAULTS. Returns a referentially stable snapshot: repeated calls yield the
 * same object (and the same nested `userKeys` array) until the persisted value
 * actually changes, and JSON is parsed only when the raw string changes.
 */
export function loadSettings(): Settings {
  const raw = readRaw();
  if (cachedRaw !== UNREAD && raw === cachedRaw) return cachedValue;
  cachedRaw = raw;
  cachedValue = parseSettings(raw);
  return cachedValue;
}

/** Merge a partial over current settings, persist, and emit a 'timber:settings' event. */
export function saveSettings(s: Partial<Settings>): Settings {
  const next: Settings = { ...loadSettings(), ...s };
  const serialized = JSON.stringify(next);
  try {
    localStorage.setItem(STORAGE_KEY, serialized);
    // Adopt the just-written value as the cached snapshot so the next
    // loadSettings() is a cache hit (no reparse) and returns this exact object.
    cachedRaw = serialized;
    cachedValue = next;
  } catch {
    // storage may be unavailable (private mode / quota); keep the in-memory
    // value but invalidate the cache so loadSettings() re-reads from source.
    cachedRaw = UNREAD;
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  return next;
}

// --- Reactive store (for useSyncExternalStore) -----------------------------
// Render-time settings reads (the data hooks' enabled gate, the Explore/Stats
// routes, theme application) must update WITHOUT waiting for an unrelated
// re-render. subscribe() notifies on both an in-tab save ('timber:settings'
// CustomEvent) and a cross-tab write (the native 'storage' event); getSnapshot()
// reuses loadSettings' raw-string cache so it returns a referentially-stable
// value — required by useSyncExternalStore, which would otherwise loop forever.

/** Register a listener for settings changes (this tab + other tabs). Returns an unsubscribe. */
export function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onSettings = () => callback();
  const onStorage = (e: StorageEvent) => {
    // key === null ⇒ storage was cleared; otherwise react only to our key.
    if (e.key === null || e.key === STORAGE_KEY) callback();
  };
  window.addEventListener(EVENT, onSettings);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, onSettings);
    window.removeEventListener("storage", onStorage);
  };
}

/** Referentially-stable current snapshot for useSyncExternalStore (reuses the loadSettings cache). */
export function getSnapshot(): Settings {
  return loadSettings();
}
