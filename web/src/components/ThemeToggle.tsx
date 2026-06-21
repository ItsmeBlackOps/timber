import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { applyTheme, resolveTheme } from "@/lib/theme";
import type { ConcreteTheme } from "@/lib/theme";
import { loadSettings, saveSettings } from "@/lib/settings";

/**
 * Light/dark switch (contract C-F9). On mount it applies the persisted choice to
 * <html data-theme>; clicking flips to the opposite concrete theme and persists
 * it via settings (so a later reload restores the explicit choice).
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<ConcreteTheme>(() =>
    resolveTheme(loadSettings().theme),
  );

  // Apply the persisted theme to <html data-theme> on first mount. This is a
  // pure DOM side effect: the useState initializer above already resolved the
  // same concrete theme into state, so we must not call setTheme here (a
  // same-value setState only forces a redundant render — see
  // react-hooks/set-state-in-effect).
  useEffect(() => {
    applyTheme(loadSettings().theme);
  }, []);

  function toggle() {
    const next: ConcreteTheme = theme === "dark" ? "light" : "dark";
    applyTheme(next);
    saveSettings({ theme: next });
    setTheme(next);
  }

  const goingTo = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${goingTo} theme`}
      title={`Switch to ${goingTo} theme`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        borderRadius: 6,
        border: "1px solid var(--tb-border)",
        background: "var(--tb-surface)",
        color: "var(--tb-text)",
        cursor: "pointer",
      }}
    >
      {theme === "dark" ? (
        <Sun size={16} aria-hidden="true" />
      ) : (
        <Moon size={16} aria-hidden="true" />
      )}
    </button>
  );
}
