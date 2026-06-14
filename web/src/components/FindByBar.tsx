// FindByBar (contract C-F9) — "find by <id>" entry point.
// Pick an id key (discovered via useFacets, default `userEmail`) and type a
// value; values autocomplete through useGroupBy(by=`ids.<key>`, like=<typed>)
// over the current filter+range. Selecting a suggestion (or pressing Add)
// emits an `ids.<key>=value` filter for the caller to merge into Filters.ids.
import { useId, useMemo, useState } from "react";

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

  const listId = useId();

  function emit(v: string) {
    const val = v.trim();
    if (val === "") return;
    onAdd({ key, value: val });
    setValue("");
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
          role="textbox"
          aria-label={`Value for ${key}`}
          aria-autocomplete="list"
          aria-controls={listId}
          placeholder={`e.g. ${key === "userEmail" ? "user@example.com" : "value"}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
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

      {suggestions.length > 0 ? (
        <ul
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
          {suggestions.map((s) => (
            <li key={s} role="option" aria-selected={false}>
              <button
                type="button"
                onClick={() => emit(s)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 8px",
                  borderRadius: 4,
                  border: "none",
                  background: "transparent",
                  color: "var(--tb-text)",
                  cursor: "pointer",
                }}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
