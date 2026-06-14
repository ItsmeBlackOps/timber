import { presetRange, PRESETS } from "@/lib/time";

export interface TimeRange {
  from?: string;
  to?: string;
}

export interface TimeRangePickerProps {
  /** Current window lower bound (ISO), if any. */
  from: string | undefined;
  /** Current window upper bound (ISO), if any. */
  to: string | undefined;
  /** Emits the new {from,to} window (ISO) on a preset click or custom edit. */
  onChange: (range: TimeRange) => void;
}

/** ISO instant -> the value a <input type=datetime-local> expects ("YYYY-MM-DDTHH:mm"). */
function isoToLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Local datetime-input value -> ISO instant; undefined when incomplete/invalid. */
function localInputToIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

const presetBtn: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  border: "1px solid var(--tb-border)",
  background: "var(--tb-surface)",
  color: "var(--tb-text)",
};

const customInput: React.CSSProperties = {
  height: 30,
  padding: "0 6px",
  borderRadius: 6,
  border: "1px solid var(--tb-border)",
  background: "var(--tb-surface)",
  color: "var(--tb-text)",
  fontSize: 12,
};

/**
 * Time-range control (contract C-F9 / spec §7). Preset buttons (15m/1h/6h/24h/7d)
 * emit a {from:now-Δ, to:now} window via lib/time.presetRange; the custom
 * from/to datetime fields emit ISO instants, each preserving the other bound.
 */
export function TimeRangePicker({ from, to, onChange }: TimeRangePickerProps) {
  function applyPreset(id: string) {
    onChange(presetRange(id, new Date()));
  }

  return (
    <div
      role="group"
      aria-label="Time range"
      style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}
    >
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => applyPreset(p.id)}
          style={presetBtn}
        >
          {p.label}
        </button>
      ))}
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--tb-mut)" }}>
        <span>From</span>
        <input
          type="datetime-local"
          aria-label="From"
          value={isoToLocalInput(from)}
          onChange={(e) => onChange({ from: localInputToIso(e.target.value), to })}
          style={customInput}
        />
      </label>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--tb-mut)" }}>
        <span>To</span>
        <input
          type="datetime-local"
          aria-label="To"
          value={isoToLocalInput(to)}
          onChange={(e) => onChange({ from, to: localInputToIso(e.target.value) })}
          style={customInput}
        />
      </label>
    </div>
  );
}
