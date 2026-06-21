import { useEffect, useId, useMemo, useRef, useState } from "react";
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
  // Index of the keyboard-highlighted option, or -1 when none is active.
  const [active, setActive] = useState(-1);

  const listId = useId();
  // Stable per-option id so aria-activedescendant can point at the row.
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const all = useMemo(() => suggestionsFor(data?.apps, app), [data, app]);
  const typed = value ?? "";
  const filtered = useMemo(() => {
    const q = typed.toLowerCase();
    return q ? all.filter((s) => s.toLowerCase().includes(q)) : all;
  }, [all, typed]);

  const listVisible = open && filtered.length > 0;

  // The highlight indexes into `filtered`; reset it whenever the list contents
  // change (new query/scope) or the popup closes so it can never dangle past
  // the end or survive a reopen.
  useEffect(() => {
    setActive(-1);
  }, [filtered, open]);

  const listRef = useRef<HTMLUListElement>(null);
  // Keep the highlighted row in view when navigating with the keyboard.
  useEffect(() => {
    if (!listVisible || active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `#${CSS.escape(optionId(active))}`,
    );
    // scrollIntoView is absent in some test environments (jsdom); it's a
    // pure UX nicety, so guard rather than depend on it.
    el?.scrollIntoView?.({ block: "nearest" });
    // optionId is derived purely from listId (stable), so it needn't be a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, listVisible, listId]);

  function select(i: number) {
    const s = filtered[i];
    if (s === undefined) return;
    onChange(s);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const n = filtered.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (!listVisible) {
          setOpen(true);
          return;
        }
        // From "none" (-1) ArrowDown lands on the first row; past the end wraps.
        setActive((i) => (i + 1) % n);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (!listVisible) {
          setOpen(true);
          return;
        }
        // From "none" (-1) ArrowUp lands on the last row; before 0 wraps.
        setActive((i) => (i <= 0 ? n - 1 : i - 1));
        break;
      case "Enter":
        // Only intercept Enter when a row is actually highlighted; otherwise
        // leave the event alone (e.g. to submit an enclosing form).
        if (listVisible && active >= 0) {
          e.preventDefault();
          select(active);
        }
        break;
      case "Escape":
        if (open) {
          e.preventDefault();
          setOpen(false);
        }
        break;
      default:
        break;
    }
  }

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <input
        type="text"
        role="combobox"
        aria-label="Event"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={listVisible ? listId : undefined}
        aria-activedescendant={
          listVisible && active >= 0 ? optionId(active) : undefined
        }
        placeholder="event prefix"
        value={typed}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? undefined : v);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
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
      {listVisible ? (
        <ul
          ref={listRef}
          id={listId}
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
          {filtered.map((s, i) => (
            <li
              key={s}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              // mousedown (not click) so selection wins the race with input blur.
              onMouseDown={(e) => {
                e.preventDefault();
                select(i);
              }}
              // Hovering syncs the keyboard highlight so mouse + keyboard agree.
              onMouseEnter={() => setActive(i)}
              style={{
                padding: "5px 8px",
                borderRadius: 4,
                cursor: "pointer",
                fontFamily: "ui-monospace, monospace",
                fontSize: 13,
                color: "var(--tb-text)",
                background:
                  i === active
                    ? "color-mix(in srgb, var(--tb-acc) 18%, transparent)"
                    : "transparent",
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
