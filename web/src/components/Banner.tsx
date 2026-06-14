export type BannerKind = "401" | "503" | "offline";

export interface BannerProps {
  kind: BannerKind;
  /** Optional action handler; when omitted no action button is rendered. */
  onAction?: () => void;
}

interface Copy {
  accent: string;
  message: string;
  action: string;
}

const COPY: Record<BannerKind, Copy> = {
  "401": {
    accent: "var(--tb-warn)",
    message:
      "Unauthorized — your read key is missing or invalid. Add a valid key in Settings to load logs.",
    action: "Open settings",
  },
  "503": {
    accent: "var(--tb-error)",
    message:
      "Storage unavailable — the server can't reach its log store right now. Retrying with backoff.",
    action: "Retry",
  },
  offline: {
    accent: "var(--tb-error)",
    message:
      "You appear to be offline — check your connection. Requests will retry automatically.",
    action: "Retry",
  },
};

/**
 * Inline status banner (contract C-F9) for the three blocking conditions the
 * console surfaces: 401 (re-auth), 503 (storage down) and offline.
 */
export function Banner({ kind, onAction }: BannerProps) {
  const copy = COPY[kind];
  return (
    <div
      role="alert"
      data-kind={kind}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 14px",
        background: "var(--tb-2)",
        color: "var(--tb-text)",
        borderInlineStart: `3px solid ${copy.accent}`,
        borderRadius: 6,
      }}
    >
      <span>{copy.message}</span>
      {onAction ? (
        <button
          type="button"
          onClick={onAction}
          style={{
            flex: "0 0 auto",
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid var(--tb-border)",
            background: "var(--tb-surface)",
            color: "var(--tb-text)",
            cursor: "pointer",
          }}
        >
          {copy.action}
        </button>
      ) : null}
    </div>
  );
}
