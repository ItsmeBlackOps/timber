import { useId, useState, type CSSProperties } from "react";
import type { Health } from "@/lib/types";

export interface HealthDotProps {
  /** Latest /healthz payload, or undefined while it is still loading. */
  health: Health | undefined;
}

type State = "ok" | "down" | "unknown";

const COLOR: Record<State, string> = {
  ok: "var(--tb-ok)",
  down: "var(--tb-error)",
  unknown: "var(--tb-mut)",
};

const LABEL: Record<State, string> = {
  ok: "Service healthy",
  down: "Service unhealthy",
  unknown: "Service health unknown",
};

// WCAG 1.4.1 (Use of Color): a short VISIBLE label beside the dot so the state
// is distinguishable without relying on the dot's color.
const TEXT: Record<State, string> = {
  ok: "Healthy",
  down: "Unhealthy",
  unknown: "Checking…",
};

// Visually hidden but kept in the DOM so a screen reader announces the detail
// via aria-describedby when the indicator is focused.
const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

/** Compact human size, e.g. 2048 -> "2.0 KB". */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 1024) return `${Math.max(0, Math.round(n))} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

function stateOf(health: Health | undefined): State {
  if (!health) return "unknown";
  return health.ok && health.mongo.connected ? "ok" : "down";
}

function tooltipFor(health: Health | undefined): string {
  if (!health) return "Health unknown — checking…";
  const { wal, flusher, mongo } = health;
  const flusherState = flusher.running
    ? flusher.caughtUp
      ? "caught up"
      : "catching up"
    : "stopped";
  const lines = [
    `Overall: ${health.ok ? "ok" : "degraded"}`,
    `WAL backlog: ${fmtBytes(wal.backlogBytes)}${
      wal.overBudget ? " (over budget)" : ""
    }`,
    `Flusher: ${flusherState} (flushed ${flusher.flushedTotal})`,
    `Mongo: ${mongo.connected ? "connected" : "disconnected"}`,
  ];
  if (flusher.lastError) lines.push(`Last error: ${flusher.lastError}`);
  return lines.join("\n");
}

/**
 * Top-bar liveness indicator (contract C-F9). Green when the service is ok and
 * Mongo is connected; red otherwise; muted when health hasn't loaded yet.
 *
 * Accessibility:
 *  - State is conveyed by a visible text label (TEXT), not the dot's color alone
 *    (WCAG 1.4.1 — colorblind-safe).
 *  - The rich detail (WAL backlog, flusher, Mongo, last error) is keyboard- and
 *    screen-reader-reachable: the indicator is focusable (tabIndex 0) and the
 *    detail is linked via aria-describedby to an sr-only node (announced on
 *    focus), plus shown in a visible disclosure on focus/hover that dismisses on
 *    Escape/blur. The native `title` is kept only as a mouse-hover fallback.
 */
export function HealthDot({ health }: HealthDotProps) {
  const state = stateOf(health);
  const detail = tooltipFor(health);
  const detailId = useId();
  const [open, setOpen] = useState(false);

  return (
    <span
      role="status"
      data-health={state}
      aria-label={LABEL[state]}
      aria-describedby={detailId}
      title={detail}
      tabIndex={0}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: "default",
        outlineOffset: 2,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: COLOR[state],
          boxShadow:
            state === "ok"
              ? "0 0 0 3px color-mix(in srgb, var(--tb-ok) 25%, transparent)"
              : undefined,
          flex: "0 0 auto",
        }}
      />
      <span data-testid="health-label" style={{ fontSize: 12, color: "var(--tb-mut)" }}>
        {TEXT[state]}
      </span>

      {/* SR-only detail, announced via aria-describedby on focus. */}
      <span id={detailId} style={srOnly}>
        {detail}
      </span>

      {/* Sighted keyboard/mouse disclosure. aria-hidden so SRs use the
          describedby copy above (no double announcement). */}
      {open ? (
        <span
          aria-hidden="true"
          data-testid="health-detail-popover"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            insetInlineEnd: 0,
            zIndex: 30,
            minWidth: 220,
            whiteSpace: "pre-line",
            padding: "8px 10px",
            borderRadius: 8,
            border: "1px solid var(--tb-border)",
            background: "var(--tb-surface)",
            color: "var(--tb-text)",
            fontSize: 12,
            lineHeight: 1.5,
            boxShadow: "0 6px 24px color-mix(in srgb, var(--tb-text) 14%, transparent)",
          }}
        >
          {detail}
        </span>
      ) : null}
    </span>
  );
}
