import { useState } from "react";
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

/**
 * Which preset id (if any) the current window length corresponds to, for
 * highlighting. Mirrors the Stats route (stats.tsx) so both surfaces agree on
 * what "active" means: a preset is active when the window span matches its
 * duration within a 1s tolerance (presets emit to=now, so the span is exact
 * the moment a preset round-trips back through props).
 */
function activePresetId(from: string | undefined, to: string | undefined): string | null {
  if (!from || !to) return null;
  const span = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(span)) return null;
  const hit = PRESETS.find((p) => Math.abs(p.ms - span) <= 1000);
  return hit ? hit.id : null;
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

/** Active-preset emphasis — same accent treatment as the Stats route. */
function activeStyle(active: boolean): React.CSSProperties {
  return active
    ? { background: "var(--tb-acc)", color: "#fff", borderColor: "var(--tb-acc)" }
    : {};
}

const customInput: React.CSSProperties = {
  height: 30,
  padding: "0 6px",
  borderRadius: 6,
  border: "1px solid var(--tb-border)",
  background: "var(--tb-surface)",
  color: "var(--tb-text)",
  fontSize: 12,
};

const invalidInput: React.CSSProperties = {
  borderColor: "var(--tb-error)",
};

const errorText: React.CSSProperties = {
  fontSize: 11,
  color: "var(--tb-error)",
};

type FieldError = { field: "from" | "to"; message: string };

/**
 * Time-range control (contract C-F9 / spec §7). Preset buttons (15m/1h/6h/24h/7d)
 * emit a {from:now-Δ, to:now} window via lib/time.presetRange and mark the
 * active window with aria-pressed; the custom from/to datetime fields emit ISO
 * instants, each preserving the other bound.
 *
 * A `from > to` edit is rejected locally rather than emitted: the server would
 * 400 (spec §7), so we surface that inline on the offending control and hold
 * the user's keystrokes there until they fix it — no inverted window escapes to
 * the URL/query.
 */
export function TimeRangePicker({ from, to, onChange }: TimeRangePickerProps) {
  // Inline validation state for an inverted (from > to) custom edit. While set,
  // the offending field shows `draft` (what the user typed) instead of the
  // prop-derived value, so the error and the input agree.
  const [error, setError] = useState<FieldError | null>(null);
  const [draft, setDraft] = useState<string>("");

  const activePreset = activePresetId(from, to);

  function applyPreset(id: string) {
    setError(null);
    onChange(presetRange(id, new Date()));
  }

  // Commit a custom edit on `field`. If both bounds are present and the result
  // would be inverted, reject inline; otherwise clear any error and emit.
  function editField(field: "from" | "to", localValue: string) {
    const iso = localInputToIso(localValue);
    const next: TimeRange = field === "from" ? { from: iso, to } : { from, to: iso };

    if (next.from && next.to) {
      const lo = new Date(next.from).getTime();
      const hi = new Date(next.to).getTime();
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi) {
        setDraft(localValue);
        setError({
          field,
          message: "Start must be on or before end — adjust the range.",
        });
        return;
      }
    }
    setError(null);
    setDraft("");
    onChange(next);
  }

  const fromValue = error?.field === "from" ? draft : isoToLocalInput(from);
  const toValue = error?.field === "to" ? draft : isoToLocalInput(to);

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
          aria-pressed={activePreset === p.id}
          onClick={() => applyPreset(p.id)}
          style={{ ...presetBtn, ...activeStyle(activePreset === p.id) }}
        >
          {p.label}
        </button>
      ))}
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--tb-mut)" }}>
        <span>From</span>
        <input
          type="datetime-local"
          aria-label="From"
          aria-invalid={error?.field === "from" || undefined}
          value={fromValue}
          onChange={(e) => editField("from", e.target.value)}
          style={error?.field === "from" ? { ...customInput, ...invalidInput } : customInput}
        />
      </label>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--tb-mut)" }}>
        <span>To</span>
        <input
          type="datetime-local"
          aria-label="To"
          aria-invalid={error?.field === "to" || undefined}
          value={toValue}
          onChange={(e) => editField("to", e.target.value)}
          style={error?.field === "to" ? { ...customInput, ...invalidInput } : customInput}
        />
      </label>
      {error ? (
        <span role="alert" style={errorText}>
          {error.message}
        </span>
      ) : null}
    </div>
  );
}
