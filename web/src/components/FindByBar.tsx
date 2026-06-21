// FindByBar (contract C-F9) — "find by <id>" entry point.
// Pick an id key (discovered via useFacets, default `userEmail`) and type a
// value; values autocomplete through useGroupBy(by=`ids.<key>`, like=<typed>)
// over the current filter+range. Selecting a suggestion (or pressing Add)
// emits an `ids.<key>=value` filter for the caller to merge into Filters.ids.
//
// a11y: the value field is a WAI-ARIA autocomplete combobox (mirrors
// EventCombobox) — role="combobox" + aria-expanded + aria-controls (only while
// the popup is shown) + aria-activedescendant over real role="option" rows, with
// ArrowUp/ArrowDown/Enter/Escape keyboard support. Suggestions are plain option
// rows (no wrapping buttons), so the listbox interaction model stays intact.
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { useFacets } from "@/hooks/useFacets";
import { useGroupBy } from "@/hooks/useGroupBy";
import type { Filters, IdFilter } from "@/lib/filters";

export interface FindByBarProps {
  /** Emits the chosen `ids.<key>=value` filter row. */
  onAdd: (filter: IdFilter) => void;
  /** Scope the facet/value discovery to one app (optional). */
  app?: string;
  /** Window for facet/value discovery; defaults to the last 24h. */
  range?: { from: string; to: string };
  /** Base filters to scope value autocomplete (default: unconstrained). */
  filters?: Filters;
}

const EMPTY_FILTERS: Filters = { levels: [], ids: [], data: [] };

/** Default discovery window: now-24h .. now (ISO). */
function defaultRange(): { from: string; to: string } {
  const now = Date.now();
  return {
    from: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(now).toISOString(),
  };
}

/** Up to this many value suggestions shown under the input. */
const SUGGEST_LIMIT = 8;

export function FindByBar({ onAdd, app, range, filters }: FindByBarProps) {
  const win = useMemo(() => range ?? defaultRange(), [range]);
  const facetsQ = useFacets(app, win);

  const keys = useMemo<string[]>(() => {
    const discovered = facetsQ.data?.idsKeys ?? [];
    // Always offer userEmail so the common "find a user" path works even before
    // facets resolve; keep discovered keys, de-duplicated, userEmail first.
    const ordered = ["userEmail", ...discovered.filter((k) => k !== "userEmail")];
    return Array.from(new Set(ordered));
  }, [facetsQ.data]);

  const [key, setKey] = useState("userEmail");
  const [value, setValue] = useState("");
  // Whether the suggestion popup is open, and the keyboard-highlighted row
  // (-1 = none active). `open` gates visibility; the list is only actually shown
  // when there is also at least one suggestion.
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const trimmed = value.trim();

  // Value autocomplete: only query once the user has typed something.
  const groupByQ = useGroupBy(`ids.${key}`, filters ?? EMPTY_FILTERS, {
    like: trimmed,
    limit: SUGGEST_LIMIT,
    enabled: trimmed.length > 0,
  });

  const suggestions = useMemo<string[]>(() => {
    if (trimmed.length === 0) return [];
    const groups = groupByQ.data?.groups ?? [];
    return groups
      .map((g) => g.value)
      .filter((v): v is string => typeof v === "string");
  }, [groupByQ.data, trimmed]);

  const listVisible = open && suggestions.length > 0;

  const listId = useId();
  // Stable per-option id so aria-activedescendant can point at the row.
  const optionId = (i: number) => `${listId}-opt-${i}`;

  // The highlight indexes into `suggestions`; reset it whenever the list
  // contents change or the popup closes so it can never dangle past the end or
  // survive a reopen.
  useEffect(() => {
    setActive(-1);
  }, [suggestions, open]);

  const listRef = useRef<HTMLUListElement>(null);
  // Keep the highlighted row in view when navigating with the keyboard.
  useEffect(() => {
    if (!listVisible || active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `#${CSS.escape(optionId(active))}`,
    );
    // scrollIntoView is absent in some test environments (jsdom); it's a pure
    // UX nicety, so guard rather than depend on it.
    el?.scrollIntoView?.({ block: "nearest" });
    // optionId is derived purely from listId (stable), so it needn't be a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, listVisible, listId]);

  function emit(v: string) {
    const val = v.trim();
    if (val === "") return;
    onAdd({ key, value: val });
    setValue("");
    setOpen(false);
  }

  function selectAt(i: number) {
    const s = suggestions[i];
    if (s === undefined) return;
    emit(s);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const n = suggestions.length;
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
        // leave it alone so the enclosing form submits the typed value.
        if (listVisible && active >= 0) {
          e.preventDefault();
          selectAt(active);
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
    <div
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
      }}
    >
      <label style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }} htmlFor={`${listId}-key`}>
        Find by key
      </label>
      <select
        id={`${listId}-key`}
        aria-label="Find by key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        style={{
          padding: "5px 8px",
          borderRadius: 6,
          border: "1px solid var(--tb-border)",
          background: "var(--tb-surface)",
          color: "var(--tb-text)",
        }}
      >
        {keys.map((k) => (
          <option key={k} value={k}>
            {k}
          </option>
        ))}
      </select>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          emit(value);
        }}
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <input
          type="text"
          role="combobox"
          aria-label={`Value for ${key}`}
          aria-expanded={listVisible}
          aria-autocomplete="list"
          aria-controls={listVisible ? listId : undefined}
          aria-activedescendant={
            listVisible && active >= 0 ? optionId(active) : undefined
          }
          placeholder={`e.g. ${key === "userEmail" ? "user@example.com" : "value"}`}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          style={{
            padding: "5px 8px",
            minWidth: 200,
            borderRadius: 6,
            border: "1px solid var(--tb-border)",
            background: "var(--tb-surface)",
            color: "var(--tb-text)",
          }}
        />
        <button
          type="submit"
          style={{
            padding: "5px 10px",
            borderRadius: 6,
            border: "1px solid var(--tb-border)",
            background: "var(--tb-acc)",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Add
        </button>
      </form>

      {listVisible ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={`${key} suggestions`}
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 20,
            margin: 0,
            padding: 4,
            listStyle: "none",
            maxHeight: 240,
            overflowY: "auto",
            background: "var(--tb-surface)",
            border: "1px solid var(--tb-border)",
            borderRadius: 6,
            boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
          }}
        >
          {suggestions.map((s, i) => (
            <li
              key={s}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              // mousedown (not click) so selection wins the race with input blur.
              onMouseDown={(e) => {
                e.preventDefault();
                selectAt(i);
              }}
              // Hovering syncs the keyboard highlight so mouse + keyboard agree.
              onMouseEnter={() => setActive(i)}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "6px 8px",
                borderRadius: 4,
                cursor: "pointer",
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
