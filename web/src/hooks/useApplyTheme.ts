// Reactively apply the persisted theme choice to <html data-theme> (contract
// C-F7). Re-applies whenever settings.theme changes — in this tab (ThemeToggle /
// SettingsDialog → saveSettings) or another tab (storage event) — and, while the
// choice is "system", whenever the OS color scheme flips. Mount once in the shell.
import { useEffect } from "react";

import { useSettings } from "@/hooks/useSettings";
import { applyTheme, watchSystemTheme } from "@/lib/theme";

export function useApplyTheme(): void {
  const { theme } = useSettings();
  useEffect(() => {
    applyTheme(theme);
    return watchSystemTheme(() => theme);
  }, [theme]);
}
