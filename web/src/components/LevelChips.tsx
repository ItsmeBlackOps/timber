import type { Level } from "@/lib/types";
import { ALL_LEVELS } from "@/lib/filters";

export interface LevelChipsProps {
  /** Currently selected levels (empty = no constraint / all). */
  value: Level[];
  /** Called with the next selection when a chip is toggled. */
  onChange: (next: Level[]) => void;
}

/** The per-level accent token (see theme/tokens.css). */
const LEVEL_VAR: Record<Level, string> = {
  debug: "--tb-debug",
  info: "--tb-info",
  warn: "--tb-warn",
  error: "--tb-error",
};

/**
 * Severity toggle chips (contract C-F9). Clicking a chip adds/removes that level
 * from `value` (selection order is preserved in server order). An empty
 * selection means "no level constraint" — filters.ts serializes empty/all-4 to
 * no `level=` param.
 *
 * a11y (WCAG AA): the per-level tokens (esp. warn/error in the light theme) drop
 * below 4.5:1 when used as *text* over the surface or the 16% tint, so a selected
 * chip carries its severity color on the border + tint and renders the label with
 * the high-contrast --tb-text token (>=12:1 in both themes). See LevelChips.test.
 */
export function LevelChips({ value, onChange }: LevelChipsProps) {
  const selected = new Set<Level>(value);

  function toggle(level: Level) {
    // Rebuild in canonical ALL_LEVELS order so output is stable.
    const next = ALL_LEVELS.filter((l) =>
      l === level ? !selected.has(l) : selected.has(l),
    );
    onChange(next);
  }

  return (
    <div role="group" aria-label="Levels" style={{ display: "inline-flex", gap: 6 }}>
      {ALL_LEVELS.map((level) => {
        const on = selected.has(level);
        const color = `var(${LEVEL_VAR[level]})`;
        return (
          <button
            key={level}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(level)}
            style={{
              padding: "3px 10px",
              borderRadius: 999,
              fontSize: 12,
              fontWeight: 600,
              textTransform: "capitalize",
              cursor: "pointer",
              // Selected: high-contrast label text (the level color rides on the
              // border + tint instead, since the level tokens fail AA as text).
              color: on ? "var(--tb-text)" : "var(--tb-mut)",
              border: `1px solid ${on ? color : "var(--tb-border)"}`,
              background: on
                ? `color-mix(in srgb, ${color} 16%, transparent)`
                : "var(--tb-surface)",
            }}
          >
            {level}
          </button>
        );
      })}
    </div>
  );
}
