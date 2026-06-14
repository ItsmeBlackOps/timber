// C-F7 (theme.ts half) — apply a theme choice to <html data-theme>.
// tokens.css (owned by F4) defines the palette per [data-theme=...]; this module
// only resolves "system" and sets the attribute.

export type ThemeChoice = "system" | "light" | "dark";
export type ConcreteTheme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemPrefersDark(): boolean {
  return (
    typeof matchMedia === "function" && matchMedia(DARK_QUERY).matches
  );
}

/** Resolve a choice to a concrete theme; "system" consults matchMedia. */
export function resolveTheme(choice: ThemeChoice): ConcreteTheme {
  if (choice === "system") return systemPrefersDark() ? "dark" : "light";
  return choice;
}

/** Set document.documentElement.dataset.theme; returns the resolved theme. */
export function applyTheme(choice: ThemeChoice): ConcreteTheme {
  const resolved = resolveTheme(choice);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

/**
 * Re-apply the current choice whenever the OS color scheme changes.
 * `getChoice` is read on each change so a later switch to explicit light/dark
 * stops tracking the system. Returns an unsubscribe function.
 */
export function watchSystemTheme(getChoice: () => ThemeChoice): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const mql = matchMedia(DARK_QUERY);
  const onChange = () => applyTheme(getChoice());
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}
