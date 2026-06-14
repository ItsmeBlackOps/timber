// GroupByPanel (contract C-F9) — horizontal count bars for one dimension
// (`by`) over the current filters, from useGroupBy. Clicking a bar calls
// onPick(value) so the caller can add it as a drill-in filter. Shows the
// server's otherCount as a trailing, non-clickable row when non-zero.
import { useGroupBy } from "@/hooks/useGroupBy";
import type { Filters } from "@/lib/filters";
import type { GroupByResponse } from "@/lib/types";

type GroupValue = GroupByResponse["groups"][number]["value"];

export interface GroupByPanelProps {
  /** Dimension to group by: `app`, `level`, `event`, `ids.<k>` or `data.<p>`. */
  by: string;
  /** Current filter scope (shared with the logs query). */
  filters: Filters;
  /** Add the clicked value as a drill-in filter. */
  onPick: (value: GroupValue) => void;
}

/** Top-N values to fetch for the breakdown. */
const BARS_LIMIT = 20;

/** Render a group value as a stable display label. */
function label(v: GroupValue): string {
  if (v === null) return "(null)";
  return String(v);
}

export function GroupByPanel({ by, filters, onPick }: GroupByPanelProps) {
  const { data, isLoading } = useGroupBy(by, filters, { limit: BARS_LIMIT });

  const groups = data?.groups ?? [];
  const otherCount = data?.otherCount ?? 0;
  // Scale bars to the largest count in view (incl. otherCount) for proportion.
  const max = Math.max(1, ...groups.map((g) => g.count), otherCount);

  return (
    <section
      aria-label={`Breakdown by ${by}`}
      style={{ display: "flex", flexDirection: "column", gap: 6, color: "var(--tb-text)" }}
    >
      <header
        style={{
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--tb-mut)",
        }}
      >
        Breakdown · {by}
      </header>

      {isLoading && groups.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--tb-mut)" }}>Loading…</p>
      ) : groups.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--tb-mut)" }}>No results for this dimension.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
          {groups.map((g, i) => {
            const text = label(g.value);
            const pct = Math.round((g.count / max) * 100);
            return (
              <li key={`${text}-${i}`}>
                <button
                  type="button"
                  onClick={() => onPick(g.value)}
                  title={`Filter by ${text}`}
                  style={{
                    position: "relative",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    width: "100%",
                    padding: "5px 8px",
                    borderRadius: 6,
                    border: "1px solid var(--tb-border)",
                    background: "var(--tb-surface)",
                    color: "var(--tb-text)",
                    cursor: "pointer",
                    overflow: "hidden",
                    font: "inherit",
                  }}
                >
                  {/* proportional fill behind the label */}
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: `${pct}%`,
                      background: "color-mix(in srgb, var(--tb-acc) 18%, transparent)",
                      pointerEvents: "none",
                    }}
                  />
                  <span
                    style={{
                      position: "relative",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {text}
                  </span>
                  <span
                    style={{
                      position: "relative",
                      flex: "0 0 auto",
                      fontVariantNumeric: "tabular-nums",
                      color: "var(--tb-mut)",
                    }}
                  >
                    {g.count}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {otherCount > 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "4px 8px",
            fontSize: 12,
            color: "var(--tb-mut)",
          }}
        >
          <span>Other</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>{otherCount}</span>
        </div>
      ) : null}
    </section>
  );
}
