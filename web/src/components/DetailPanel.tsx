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
import { useDeferredValue, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

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

/**
 * One tab in the inspector's tablist. Implements the APG Tabs pattern bits that
 * belong on the control: a stable `id`, `aria-controls` pointing at the shared
 * tabpanel, `aria-selected`, and a roving `tabindex` (0 only when selected, so
 * Tab reaches the active tab and Arrow keys move between tabs). Keyboard
 * navigation is owned by the parent tablist via `onKeyDown`.
 */
function SegButton({
  id,
  panelId,
  active,
  onClick,
  onKeyDown,
  tabRef,
  children,
}: {
  id: string;
  panelId: string;
  active: boolean;
  onClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  tabRef: (el: HTMLButtonElement | null) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={id}
      aria-controls={panelId}
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      ref={tabRef}
      onClick={onClick}
      onKeyDown={onKeyDown}
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

/** Tabs in tablist order; drives roving focus and Arrow/Home/End navigation. */
const SEGMENTS: readonly Segment[] = ["reqres", "raw"];

export function DetailPanel({ doc, onPivot }: DetailPanelProps) {
  const [segment, setSegment] = useState<Segment>("reqres");
  const [query, setQuery] = useState("");

  // Stable id roots so each tab can be aria-controls'd to the single tabpanel
  // and the panel can be aria-labelledby the active tab (APG Tabs pattern).
  const baseId = useId();
  const tabId = (s: Segment) => `${baseId}-tab-${s}`;
  const panelId = `${baseId}-panel`;

  // Refs to each tab button keyed by segment, so the tablist's keyboard handler
  // can move focus to the newly selected tab (roving tabindex + auto-activate).
  const tabRefs = useRef<Partial<Record<Segment, HTMLButtonElement | null>>>({});

  // Horizontal tablist navigation: Arrow keys move (and, with automatic
  // activation, select) the adjacent tab and wrap; Home/End jump to the ends.
  function onTabKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    const count = SEGMENTS.length;
    const current = SEGMENTS.indexOf(segment);
    // Assigned in every non-returning switch branch below (the `default` case
    // returns early), so no initializer is needed — and an unused `= current`
    // seed trips no-useless-assignment.
    let next: number;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (current + 1) % count;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (current - 1 + count) % count;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const nextSeg = SEGMENTS[next];
    setSegment(nextSeg);
    tabRefs.current[nextSeg]?.focus();
  }

  const iso = doc.ts ?? doc.receivedAt;
  const idEntries = Object.entries(doc.ids ?? {});

  // The trimmed query fans out as `highlight` to every visible leaf of a
  // potentially huge JsonTree. Deferring it keeps the controlled <input> snappy:
  // React updates the input urgently and deprioritizes the tree's highlight
  // recompute (paired with the memoized Node in JsonTree). `isStale` is true
  // while the deferred value lags, surfaced as aria-busy on the body.
  const trimmed = query.trim() || undefined;
  const highlight = useDeferredValue(trimmed);
  const isStale = highlight !== trimmed;

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
          <SegButton
            id={tabId("reqres")}
            panelId={panelId}
            active={segment === "reqres"}
            onClick={() => setSegment("reqres")}
            onKeyDown={onTabKeyDown}
            tabRef={(el) => {
              tabRefs.current.reqres = el;
            }}
          >
            Request / Response
          </SegButton>
          <SegButton
            id={tabId("raw")}
            panelId={panelId}
            active={segment === "raw"}
            onClick={() => setSegment("raw")}
            onKeyDown={onTabKeyDown}
            tabRef={(el) => {
              tabRefs.current.raw = el;
            }}
          >
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

      {/* Body — the single tabpanel, labelled by whichever tab is active. */}
      <div
        data-testid="detail-body"
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(segment)}
        tabIndex={0}
        aria-busy={isStale}
      >
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
