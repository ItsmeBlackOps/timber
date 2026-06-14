// DetailPanel (Task F7) — the inspector for a single selected log document.
//
// Layout:
//   - Header: level chip, app, event (mono), time (relative + absolute title),
//     and one clickable chip per ids.* entry (clicking pivots that id).
//   - A segmented switch: "Request / Response" (ReqResView over doc.data) and
//     "Raw" (a JsonTree of the whole document).
//   - An in-document search box that highlights matching keys/values in the
//     active view (threaded down as JsonTree's `highlight`).
//   - Copy full JSON + copy deep link (the current URL) actions.
//
// onPivot bubbles up the PivotFragment from any leaf or ids chip; the Explore
// route maps it onto the URL Filters.
import { useState } from "react";

import { JsonTree } from "@/components/JsonTree";
import type { PivotFragment } from "@/components/JsonTree";
import { ReqResView } from "@/components/ReqResView";
import { fmtAbsolute, fmtRelative } from "@/lib/time";
import type { Level, LogDoc } from "@/lib/types";

export interface DetailPanelProps {
  doc: LogDoc;
  onPivot: (fragment: PivotFragment) => void;
}

type Segment = "reqres" | "raw";

const LEVEL_COLOR: Record<Level, string> = {
  debug: "var(--tb-debug)",
  info: "var(--tb-info)",
  warn: "var(--tb-warn)",
  error: "var(--tb-error)",
};

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text);
}

function LevelChip({ level }: { level: Level }) {
  const color = LEVEL_COLOR[level];
  return (
    <span
      data-testid="level-chip"
      data-level={level}
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
      }}
    >
      {level}
    </span>
  );
}

/** A clickable ids.<key> chip that pivots to "all logs where key=value". */
function IdChip({
  idKey,
  value,
  onPivot,
}: {
  idKey: string;
  value: string;
  onPivot: (f: PivotFragment) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPivot({ kind: "ids", path: idKey, value })}
      title={`Filter by ${idKey} = ${value}`}
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 4,
        padding: "1px 8px",
        borderRadius: 6,
        border: "1px solid var(--tb-border)",
        background: "var(--tb-2)",
        color: "var(--tb-text)",
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      <span style={{ color: "var(--tb-mut)" }}>{idKey}</span>
      <span style={{ fontFamily: "ui-monospace, monospace" }}>{value}</span>
    </button>
  );
}

function SegButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        padding: "4px 12px",
        fontSize: 13,
        border: "1px solid var(--tb-border)",
        background: active ? "var(--tb-acc)" : "var(--tb-surface)",
        color: active ? "var(--tb-bg)" : "var(--tb-text)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

export function DetailPanel({ doc, onPivot }: DetailPanelProps) {
  const [segment, setSegment] = useState<Segment>("reqres");
  const [query, setQuery] = useState("");

  const iso = doc.ts ?? doc.receivedAt;
  const idEntries = Object.entries(doc.ids ?? {});
  const highlight = query.trim() || undefined;

  return (
    <div
      data-detail-panel
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: 14,
        background: "var(--tb-surface)",
        border: "1px solid var(--tb-border)",
        borderRadius: 10,
        color: "var(--tb-text)",
      }}
    >
      {/* Header */}
      <div data-testid="detail-header" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <LevelChip level={doc.level} />
          <span style={{ fontWeight: 600 }}>{doc.app}</span>
          <span
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 13,
              color: "var(--tb-acc)",
            }}
          >
            {doc.event}
          </span>
          <span
            data-testid="detail-time"
            title={fmtAbsolute(iso)}
            style={{ marginInlineStart: "auto", fontSize: 12, color: "var(--tb-mut)" }}
          >
            {fmtRelative(iso, new Date())}
          </span>
        </div>

        {doc.message ? (
          <div style={{ fontSize: 13, color: "var(--tb-text)" }}>{doc.message}</div>
        ) : null}

        {idEntries.length > 0 ? (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {idEntries.map(([k, v]) => (
              <IdChip key={k} idKey={k} value={String(v)} onPivot={onPivot} />
            ))}
          </div>
        ) : null}
      </div>

      {/* Controls: segment switch + search + copy actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div role="tablist" aria-label="Inspector view" style={{ display: "inline-flex" }}>
          <SegButton active={segment === "reqres"} onClick={() => setSegment("reqres")}>
            Request / Response
          </SegButton>
          <SegButton active={segment === "raw"} onClick={() => setSegment("raw")}>
            Raw
          </SegButton>
        </div>

        <input
          type="search"
          role="searchbox"
          aria-label="Search within document"
          placeholder="Search keys & values…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            flex: "1 1 160px",
            minWidth: 120,
            padding: "4px 8px",
            fontSize: 13,
            background: "var(--tb-bg)",
            color: "var(--tb-text)",
            border: "1px solid var(--tb-border)",
            borderRadius: 6,
          }}
        />

        <button
          type="button"
          onClick={() => copyText(JSON.stringify(doc, null, 2))}
          style={actionBtn}
        >
          Copy JSON
        </button>
        <button
          type="button"
          onClick={() => copyText(window.location.href)}
          style={actionBtn}
        >
          Copy deep link
        </button>
      </div>

      {/* Body */}
      <div>
        {segment === "reqres" ? (
          <ReqResView data={doc.data} onPivot={onPivot} highlight={highlight} />
        ) : (
          <JsonTree value={doc} path="" onPivot={onPivot} highlight={highlight} />
        )}
      </div>
    </div>
  );
}

const actionBtn: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 13,
  border: "1px solid var(--tb-border)",
  borderRadius: 6,
  background: "var(--tb-surface)",
  color: "var(--tb-text)",
  cursor: "pointer",
};
