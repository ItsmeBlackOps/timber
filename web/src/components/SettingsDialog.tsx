import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  DEFAULTS,
  loadSettings,
  saveSettings,
  isSameOriginBaseUrl,
} from "@/lib/settings";
import type { Settings } from "@/lib/settings";
import { applyTheme } from "@/lib/theme";

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

type ThemeChoice = Settings["theme"];

const THEME_OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** ["userEmail","userId"] <-> "userEmail, userId" for the text input. */
function keysToText(keys: string[]): string {
  return keys.join(", ");
}
function textToKeys(text: string): string[] {
  return text
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Coerce a numeric input back to a finite number, falling back to a default. */
function toNumber(raw: string, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--tb-mut)",
  marginBottom: 4,
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 10px",
  borderRadius: 6,
  border: "1px solid var(--tb-border)",
  background: "var(--tb-bg)",
  color: "var(--tb-text)",
  fontSize: 14,
};

/**
 * Settings editor (spec §8.5 / contract C-F9). Edits the read key, API base URL,
 * theme, live-tail interval, user-identity keys and slow threshold, then persists
 * them via lib/settings (which emits 'timber:settings' so hooks re-read). The
 * theme is also applied to <html> immediately on save. Cancel / close discard.
 *
 * State is seeded from settings each time the dialog opens, so reopening after a
 * cancel shows the persisted values, not the abandoned edits.
 */
/** Tabbable elements inside the panel, in DOM order (skips disabled/hidden). */
function focusableEls(panel: HTMLElement): HTMLElement[] {
  const sel =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(panel.querySelectorAll<HTMLElement>(sel)).filter(
    (el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
  );
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const ids = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [readKey, setReadKey] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");
  const [theme, setTheme] = useState<ThemeChoice>("system");
  const [tailIntervalMs, setTailIntervalMs] = useState(
    String(DEFAULTS.tailIntervalMs),
  );
  const [userKeys, setUserKeys] = useState(keysToText(DEFAULTS.userKeys));
  const [slowMs, setSlowMs] = useState(String(DEFAULTS.slowMs));
  // SECURITY: validation message for a cross-origin API base URL (would carry
  // the read key off-origin). Empty string = no error.
  const [baseUrlError, setBaseUrlError] = useState("");

  // Re-seed from persisted settings whenever the dialog transitions to open.
  useEffect(() => {
    if (!open) return;
    const s = loadSettings();
    setReadKey(s.readKey);
    setApiBaseUrl(s.apiBaseUrl);
    setTheme(s.theme);
    setTailIntervalMs(String(s.tailIntervalMs));
    setUserKeys(keysToText(s.userKeys));
    setSlowMs(String(s.slowMs));
    setBaseUrlError("");
  }, [open]);

  // Focus management for the modal (WCAG 2.4.3): on open, remember what had
  // focus and move focus into the dialog; on close, restore it. The Tab-cycle
  // trap lives in the panel's onKeyDown so focus cannot leave the dialog.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) {
      const first = focusableEls(panel)[0];
      (first ?? panel).focus();
    }
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const els = focusableEls(panel);
    if (els.length === 0) {
      e.preventDefault();
      return;
    }
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !panel.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  function save() {
    const trimmedBase = apiBaseUrl.trim();
    // SECURITY: refuse a cross-origin base URL — persisting it would let apiGet
    // send the read key to a foreign host. Keep the dialog open and surface the
    // error instead of silently saving an exfiltration vector.
    if (!isSameOriginBaseUrl(trimmedBase)) {
      setBaseUrlError(
        "API base URL must be empty or the same origin as this console.",
      );
      return;
    }
    const next: Partial<Settings> = {
      readKey: readKey.trim(),
      apiBaseUrl: trimmedBase,
      theme,
      tailIntervalMs: toNumber(tailIntervalMs, DEFAULTS.tailIntervalMs),
      userKeys: textToKeys(userKeys),
      slowMs: toNumber(slowMs, DEFAULTS.slowMs),
    };
    setBaseUrlError("");
    saveSettings(next);
    applyTheme(theme);
    onClose();
  }

  const titleId = `${ids}-title`;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, var(--tb-bg) 70%, transparent)",
        zIndex: 50,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          width: "min(480px, 92vw)",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 20,
          borderRadius: 12,
          border: "1px solid var(--tb-border)",
          background: "var(--tb-surface)",
          color: "var(--tb-text)",
          boxShadow: "0 10px 40px rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <h2 id={titleId} style={{ margin: 0, fontSize: 18 }}>
            Settings
          </h2>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              borderRadius: 6,
              border: "1px solid var(--tb-border)",
              background: "var(--tb-surface)",
              color: "var(--tb-mut)",
              cursor: "pointer",
            }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label htmlFor={`${ids}-key`} style={labelStyle}>
              Read key
            </label>
            <input
              id={`${ids}-key`}
              type="password"
              autoComplete="off"
              value={readKey}
              onChange={(e) => setReadKey(e.target.value)}
              placeholder="r-assistant-…"
              style={fieldStyle}
            />
          </div>

          <div>
            <label htmlFor={`${ids}-base`} style={labelStyle}>
              API base URL
            </label>
            <input
              id={`${ids}-base`}
              type="text"
              value={apiBaseUrl}
              onChange={(e) => {
                setApiBaseUrl(e.target.value);
                if (baseUrlError) setBaseUrlError("");
              }}
              placeholder="(same origin)"
              aria-invalid={baseUrlError ? true : undefined}
              aria-describedby={baseUrlError ? `${ids}-base-err` : undefined}
              style={
                baseUrlError
                  ? { ...fieldStyle, borderColor: "var(--tb-error)" }
                  : fieldStyle
              }
            />
            {baseUrlError ? (
              <p
                id={`${ids}-base-err`}
                role="alert"
                style={{
                  margin: "4px 0 0",
                  fontSize: 11,
                  color: "var(--tb-error)",
                }}
              >
                {baseUrlError}
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor={`${ids}-theme`} style={labelStyle}>
              Theme
            </label>
            <select
              id={`${ids}-theme`}
              value={theme}
              onChange={(e) => setTheme(e.target.value as ThemeChoice)}
              style={fieldStyle}
            >
              {THEME_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor={`${ids}-tail`} style={labelStyle}>
              Tail interval (ms)
            </label>
            <input
              id={`${ids}-tail`}
              type="number"
              min={250}
              step={250}
              value={tailIntervalMs}
              onChange={(e) => setTailIntervalMs(e.target.value)}
              style={fieldStyle}
            />
          </div>

          <div>
            <label htmlFor={`${ids}-keys`} style={labelStyle}>
              User identity keys
            </label>
            <input
              id={`${ids}-keys`}
              type="text"
              value={userKeys}
              onChange={(e) => setUserKeys(e.target.value)}
              placeholder="userEmail, userId"
              style={fieldStyle}
            />
            <p
              style={{
                margin: "4px 0 0",
                fontSize: 11,
                color: "var(--tb-mut)",
              }}
            >
              Comma-separated, in priority order. Default for "By user" / Find-by.
            </p>
          </div>

          <div>
            <label htmlFor={`${ids}-slow`} style={labelStyle}>
              Slow threshold (ms)
            </label>
            <input
              id={`${ids}-slow`}
              type="number"
              min={1}
              step={50}
              value={slowMs}
              onChange={(e) => setSlowMs(e.target.value)}
              style={fieldStyle}
            />
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 20,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              border: "1px solid var(--tb-border)",
              background: "var(--tb-surface)",
              color: "var(--tb-text)",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              border: "1px solid var(--tb-acc)",
              background: "var(--tb-acc)",
              color: "var(--tb-bg)",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
