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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Load settings, merging any stored partial over DEFAULTS. Corrupt/missing → DEFAULTS. */
export function loadSettings(): Settings {
  let stored: unknown;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ...DEFAULTS };
    stored = JSON.parse(raw);
  } catch {
    return { ...DEFAULTS };
  }
  if (!isRecord(stored)) return { ...DEFAULTS };
  return { ...DEFAULTS, ...stored };
}

/** Merge a partial over current settings, persist, and emit a 'timber:settings' event. */
export function saveSettings(s: Partial<Settings>): Settings {
  const next: Settings = { ...loadSettings(), ...s };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage may be unavailable (private mode / quota); keep the in-memory value.
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  return next;
}
