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
 * Hovering shows WAL backlog, flusher and Mongo state.
 */
export function HealthDot({ health }: HealthDotProps) {
  const state = stateOf(health);
  const tooltip = tooltipFor(health);
  return (
    <span
      role="status"
      data-health={state}
      aria-label={LABEL[state]}
      title={tooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        cursor: "default",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: COLOR[state],
          boxShadow: state === "ok" ? "0 0 0 3px color-mix(in srgb, var(--tb-ok) 25%, transparent)" : undefined,
          flex: "0 0 auto",
        }}
      />
    </span>
  );
}
