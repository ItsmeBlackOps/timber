// LogRow (Task F7) — one row of the virtualized results table.
// Columns (spec §8.2): Time (relative; absolute on hover) · Level chip · App ·
// Event (mono) · Message (single-line, ellipsis-clamped; full text on hover).
//
// Rendered with role="row" so the table reads correctly and selection is
// exposed via aria-selected. The row is the SOLE gateway to the DetailPanel
// (inspect / pivot-on-value / copy-JSON / copy-deep-link), so it must be
// operable by keyboard, not just the mouse (WCAG 2.1.1, Level A): it is
// placed in the tab order (tabIndex 0) and activates on Enter/Space.
// Colors are theme tokens only.
//
// Memoized (React.memo): ResultsTable virtualizes the list AND hands each row
// reference-stable props (a cached per-row onClick + the same doc/selected) so
// that ExploreRoute's frequent re-renders — the 2s live-tail tick, facet churn —
// don't re-render the visible rows. That payoff only lands if the row itself
// short-circuits on unchanged props, which the default shallow prop compare here
// provides; without it every visible row re-renders on each parent tick despite
// the stable props. When a prop does change (selection flips, a new doc), memo
// falls through to a normal render, so there's no correctness cost.
import { memo } from "react";
import type { CSSProperties, KeyboardEvent } from "react";

import { fmtAbsolute, fmtRelative } from "@/lib/time";
import type { Level, LogDoc } from "@/lib/types";

export interface LogRowProps {
  doc: LogDoc;
  selected: boolean;
  onClick: () => void;
}

/** Per-level chip color (matches tokens.css level vars). */
const LEVEL_COLOR: Record<Level, string> = {
  debug: "var(--tb-debug)",
  info: "var(--tb-info)",
  warn: "var(--tb-warn)",
  error: "var(--tb-error)",
};

const cellBase: CSSProperties = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// A visible focus ring for keyboard users only (:focus-visible) — inline styles
// can't express pseudo-classes, and this component has no className/CSS-module
// convention, so we inject one tiny scoped rule once. Keyed to data-tb-row so it
// never leaks onto other elements; color is a theme token (accent), not a hex.
const FOCUS_STYLE_ID = "tb-logrow-focus";
const FOCUS_STYLE = `[data-tb-row]:focus-visible{outline:2px solid var(--tb-acc);outline-offset:-2px;}`;

function ensureFocusStyle() {
  if (typeof document === "undefined") return;
  if (document.getElementById(FOCUS_STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = FOCUS_STYLE_ID;
  el.textContent = FOCUS_STYLE;
  document.head.appendChild(el);
}

function LogRowImpl({ doc, selected, onClick }: LogRowProps) {
  // Prefer the producer timestamp; fall back to ingest time.
  const iso = doc.ts ?? doc.receivedAt;
  const now = new Date();
  const color = LEVEL_COLOR[doc.level];

  ensureFocusStyle();

  // Keyboard activation: Enter and Space open the row's DetailPanel, mirroring a
  // click. Space's default (page scroll) is suppressed. Other keys pass through
  // (so a future roving-tabindex grid model in ResultsTable can own arrow keys).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <div
      role="row"
      aria-selected={selected}
      tabIndex={0}
      data-tb-row=""
      onClick={onClick}
      onKeyDown={onKeyDown}
      style={{
        display: "grid",
        gridTemplateColumns: "92px 68px 120px minmax(140px, 1fr) minmax(0, 2fr)",
        alignItems: "center",
        gap: 10,
        padding: "6px 12px",
        cursor: "pointer",
        borderBottom: "1px solid var(--tb-border)",
        background: selected ? "var(--tb-2)" : "transparent",
        color: "var(--tb-text)",
        fontSize: 13,
      }}
    >
      <span
        role="gridcell"
        data-testid="row-time"
        title={fmtAbsolute(iso)}
        style={{ ...cellBase, color: "var(--tb-mut)", fontVariantNumeric: "tabular-nums" }}
      >
        {fmtRelative(iso, now)}
      </span>

      <span role="gridcell" style={{ overflow: "hidden" }}>
        <span
          data-testid="level-chip"
          data-level={doc.level}
          style={{
            display: "inline-block",
            padding: "1px 8px",
            borderRadius: 999,
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.3,
            color,
            border: `1px solid ${color}`,
            background: "transparent",
          }}
        >
          {doc.level}
        </span>
      </span>

      <span
        role="gridcell"
        data-testid="row-app"
        style={{ ...cellBase, color: "var(--tb-text)" }}
      >
        {doc.app}
      </span>

      <span
        role="gridcell"
        data-testid="row-event"
        title={doc.event}
        style={{
          ...cellBase,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          color: "var(--tb-acc)",
        }}
      >
        {doc.event}
      </span>

      <span
        role="gridcell"
        data-testid="row-message"
        title={doc.message ?? ""}
        style={{ ...cellBase, color: "var(--tb-text)" }}
      >
        {doc.message ?? "—"}
      </span>
    </div>
  );
}

export const LogRow = memo(LogRowImpl);
