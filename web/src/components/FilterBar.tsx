import type { Filters } from "@/lib/filters";
import { LevelChips } from "@/components/LevelChips";
import { EventCombobox } from "@/components/EventCombobox";
import { TimeRangePicker } from "@/components/TimeRangePicker";
import { AdvancedFilters } from "@/components/AdvancedFilters";

export interface FilterBarProps {
  /** Current filter state (single source of truth lives in the URL upstream). */
  filters: Filters;
  /** Emits the complete next Filters whenever any control changes. */
  onChange: (next: Filters) => void;
}

const labelStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  color: "var(--tb-mut)",
};

const textInput: React.CSSProperties = {
  height: 32,
  padding: "0 8px",
  borderRadius: 6,
  border: "1px solid var(--tb-border)",
  background: "var(--tb-surface)",
  color: "var(--tb-text)",
  fontSize: 13,
};

/**
 * The Explore filter bar (contract C-F9 / spec §8.2). Composes the level chips,
 * event combobox, free-text query, time-range picker and the advanced id/data
 * rows; each child's change is merged into the current `filters` and re-emitted
 * as a complete Filters so the parent can write it straight to the URL.
 *
 * (The AppSwitcher lives in the shell — it scopes the app across pages — so it
 * is not composed here.)
 */
export function FilterBar({ filters, onChange }: FilterBarProps) {
  function patch(part: Partial<Filters>) {
    onChange({ ...filters, ...part });
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 12,
        borderRadius: 10,
        border: "1px solid var(--tb-border)",
        background: "var(--tb-surface)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <LevelChips
          value={filters.levels}
          onChange={(levels) => patch({ levels })}
        />
        <label style={labelStyle}>
          <span>Event</span>
          <EventCombobox
            app={filters.app}
            value={filters.event}
            onChange={(event) => patch({ event })}
          />
        </label>
        <label style={labelStyle}>
          <span>Message</span>
          <input
            type="text"
            aria-label="Message text (regex)"
            placeholder="regex over message"
            value={filters.q ?? ""}
            onChange={(e) =>
              patch({ q: e.target.value === "" ? undefined : e.target.value })
            }
            style={{ ...textInput, width: 200 }}
          />
        </label>
        <label style={labelStyle}>
          <span>Env</span>
          <input
            type="text"
            aria-label="Environment"
            placeholder="env"
            value={filters.env ?? ""}
            onChange={(e) =>
              patch({ env: e.target.value === "" ? undefined : e.target.value })
            }
            style={{ ...textInput, width: 110 }}
          />
        </label>
      </div>

      <TimeRangePicker
        from={filters.from}
        to={filters.to}
        onChange={({ from, to }) => patch({ from, to })}
      />

      <AdvancedFilters
        ids={filters.ids}
        data={filters.data}
        onChange={({ ids, data }) => patch({ ids, data })}
      />
    </div>
  );
}
