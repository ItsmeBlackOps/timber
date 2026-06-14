// C-F6 — time presets + relative/absolute formatting.

export interface RangePreset {
  id: string;
  label: string;
  ms: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const PRESETS: RangePreset[] = [
  { id: "15m", label: "Last 15 min", ms: 15 * MIN },
  { id: "1h", label: "Last hour", ms: HOUR },
  { id: "6h", label: "Last 6 hours", ms: 6 * HOUR },
  { id: "24h", label: "Last 24 hours", ms: DAY },
  { id: "7d", label: "Last 7 days", ms: 7 * DAY },
];

/** Window for a preset id: { from: now-ms, to: now }, both as ISO strings. */
export function presetRange(id: string, now: Date): { from: string; to: string } {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`unknown range preset: ${id}`);
  const to = now.toISOString();
  const from = new Date(now.getTime() - preset.ms).toISOString();
  return { from, to };
}

/** Coarse "12s ago" / "3m ago" / "5h ago" / "3d ago". Future → "0s ago". */
export function fmtRelative(iso: string, now: Date): string {
  const deltaMs = now.getTime() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(deltaMs / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local wall-clock "YYYY-MM-DD HH:mm:ss". */
export function fmtAbsolute(iso: string): string {
  const d = new Date(iso);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}
