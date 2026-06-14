// LogRow (Task F7) — one row of the virtualized results table.
// Columns (spec §8.2): Time (relative; absolute on hover) · Level chip · App ·
// Event (mono) · Message (single-line, ellipsis-clamped; full text on hover).
//
// Rendered with role="row" so the table reads correctly and selection is
// exposed via aria-selected. Colors are theme tokens only.
import type { CSSProperties } from "react";

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

export function LogRow({ doc, selected, onClick }: LogRowProps) {
  // Prefer the producer timestamp; fall back to ingest time.
  const iso = doc.ts ?? doc.receivedAt;
  const now = new Date();
  const color = LEVEL_COLOR[doc.level];

  return (
    <div
      role="row"
      aria-selected={selected}
      onClick={onClick}
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
        role="cell"
        data-testid="row-time"
        title={fmtAbsolute(iso)}
        style={{ ...cellBase, color: "var(--tb-mut)", fontVariantNumeric: "tabular-nums" }}
      >
        {fmtRelative(iso, now)}
      </span>

      <span role="cell" style={{ overflow: "hidden" }}>
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
        role="cell"
        data-testid="row-app"
        style={{ ...cellBase, color: "var(--tb-text)" }}
      >
        {doc.app}
      </span>

      <span
        role="cell"
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
        role="cell"
        data-testid="row-message"
        title={doc.message ?? ""}
        style={{ ...cellBase, color: "var(--tb-text)" }}
      >
        {doc.message ?? "—"}
      </span>
    </div>
  );
}
