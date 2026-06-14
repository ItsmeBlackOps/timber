export interface AppSwitcherProps {
  /** Known app names (e.g. Object.keys(eventsResponse.apps)). */
  apps: string[];
  /** Currently scoped app, or undefined for "all apps". */
  value: string | undefined;
  /** Called with the chosen app, or undefined when "all apps" is selected. */
  onChange: (app: string | undefined) => void;
}

/** Sentinel option value for "all apps" (empty string can't be an app name). */
const ALL = "__all__";

/**
 * App scope selector for the shell (contract C-F9 / spec §8.1). A native
 * <select> with an "all apps" entry plus one option per known app. Selecting
 * "all apps" emits `undefined`.
 */
export function AppSwitcher({ apps, value, onChange }: AppSwitcherProps) {
  return (
    <select
      aria-label="App"
      value={value ?? ALL}
      onChange={(e) => {
        const v = e.target.value;
        onChange(v === ALL ? undefined : v);
      }}
      style={{
        height: 32,
        padding: "0 8px",
        borderRadius: 6,
        border: "1px solid var(--tb-border)",
        background: "var(--tb-surface)",
        color: "var(--tb-text)",
        fontSize: 13,
        cursor: "pointer",
      }}
    >
      <option value={ALL}>All apps</option>
      {apps.map((app) => (
        <option key={app} value={app}>
          {app}
        </option>
      ))}
    </select>
  );
}
