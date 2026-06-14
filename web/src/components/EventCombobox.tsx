import { useMemo, useState } from "react";
import { useEvents } from "@/hooks";

export interface EventComboboxProps {
  /** Current app scope; limits suggestions to that app's event prefixes. */
  app: string | undefined;
  /** Current event-prefix value (controlled). */
  value: string | undefined;
  /** Emits the typed/selected prefix, or undefined when cleared. */
  onChange: (event: string | undefined) => void;
}

/** Distinct, sorted event prefixes for the scope (one app, or all apps). */
function suggestionsFor(
  apps: Record<string, string[]> | undefined,
  app: string | undefined,
): string[] {
  if (!apps) return [];
  const out = new Set<string>();
  if (app) {
    for (const ev of apps[app] ?? []) out.add(ev);
  } else {
    for (const list of Object.values(apps)) {
      for (const ev of list) out.add(ev);
    }
  }
  return [...out].sort();
}

/**
 * Event-prefix combobox (contract C-F9). A free-text input that emits the typed
 * prefix (the server matches `event=` as a prefix) plus a suggestion listbox
 * sourced from useEvents(), scoped to the current app and filtered by what is
 * typed. Picking a suggestion emits its full value.
 */
export function EventCombobox({ app, value, onChange }: EventComboboxProps) {
  const { data } = useEvents();
  const [open, setOpen] = useState(false);

  const all = useMemo(() => suggestionsFor(data?.apps, app), [data, app]);
  const typed = value ?? "";
  const filtered = useMemo(() => {
    const q = typed.toLowerCase();
    return q ? all.filter((s) => s.toLowerCase().includes(q)) : all;
  }, [all, typed]);

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <input
        type="text"
        role="combobox"
        aria-label="Event"
        aria-expanded={open}
        aria-autocomplete="list"
        placeholder="event prefix"
        value={typed}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? undefined : v);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{
          height: 32,
          padding: "0 8px",
          width: 180,
          borderRadius: 6,
          border: "1px solid var(--tb-border)",
          background: "var(--tb-surface)",
          color: "var(--tb-text)",
          fontFamily: "ui-monospace, monospace",
          fontSize: 13,
        }}
      />
      {open && filtered.length > 0 ? (
        <ul
          role="listbox"
          aria-label="Event suggestions"
          style={{
            position: "absolute",
            zIndex: 20,
            top: "calc(100% + 4px)",
            left: 0,
            minWidth: 180,
            maxHeight: 240,
            overflowY: "auto",
            margin: 0,
            padding: 4,
            listStyle: "none",
            borderRadius: 6,
            border: "1px solid var(--tb-border)",
            background: "var(--tb-surface)",
            boxShadow: "0 6px 20px color-mix(in srgb, var(--tb-text) 12%, transparent)",
          }}
        >
          {filtered.map((s) => (
            <li
              key={s}
              role="option"
              aria-selected={s === typed}
              // mousedown (not click) so selection wins the race with input blur.
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(s);
                setOpen(false);
              }}
              style={{
                padding: "5px 8px",
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: "ui-monospace, monospace",
                fontSize: 13,
                color: "var(--tb-text)",
              }}
            >
              {s}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
