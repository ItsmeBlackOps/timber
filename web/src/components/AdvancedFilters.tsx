import { Plus, X } from "lucide-react";
import type { IdFilter, DataFilter } from "@/lib/filters";

export interface AdvancedFiltersChange {
  ids: IdFilter[];
  data: DataFilter[];
}

export interface AdvancedFiltersProps {
  /** Current `ids.<key>=value` rows. */
  ids: IdFilter[];
  /** Current `data.<path>` (eq/gte/lte) rows. */
  data: DataFilter[];
  /** Emits the full updated id + data row sets on any add/edit/remove. */
  onChange: (next: AdvancedFiltersChange) => void;
}

const DATA_OPS: DataFilter["op"][] = ["eq", "gte", "lte"];

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const inputStyle: React.CSSProperties = {
  height: 30,
  padding: "0 8px",
  borderRadius: 6,
  border: "1px solid var(--tb-border)",
  background: "var(--tb-surface)",
  color: "var(--tb-text)",
  fontSize: 13,
};

const addBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 8px",
  borderRadius: 6,
  fontSize: 12,
  cursor: "pointer",
  border: "1px dashed var(--tb-border)",
  background: "transparent",
  color: "var(--tb-mut)",
};

const removeBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: 6,
  cursor: "pointer",
  border: "1px solid var(--tb-border)",
  background: "var(--tb-surface)",
  color: "var(--tb-mut)",
};

/**
 * Advanced filter editor (contract C-F9 / spec §7): repeatable `ids.<key>=value`
 * rows and `data.<path>` rows with an eq/gte/lte operator. Add/edit/remove all
 * emit the full updated row sets via onChange (the parent owns state). Pure
 * presentational — colors from theme tokens only.
 */
export function AdvancedFilters({ ids, data, onChange }: AdvancedFiltersProps) {
  function setIds(nextIds: IdFilter[]) {
    onChange({ ids: nextIds, data });
  }
  function setData(nextData: DataFilter[]) {
    onChange({ ids, data: nextData });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* ----- ids.<key>=value rows ----- */}
      <fieldset style={{ border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <legend style={{ fontSize: 12, color: "var(--tb-mut)", padding: 0 }}>ID filters</legend>
        {ids.map((row, i) => (
          <div key={i} data-testid="id-row" style={rowStyle}>
            <input
              type="text"
              aria-label="ID key"
              placeholder="key (e.g. userEmail)"
              value={row.key}
              onChange={(e) =>
                setIds(ids.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
              }
              style={inputStyle}
            />
            <span aria-hidden="true" style={{ color: "var(--tb-mut)" }}>=</span>
            <input
              type="text"
              aria-label="ID value"
              placeholder="value"
              value={row.value}
              onChange={(e) =>
                setIds(ids.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
              }
              style={inputStyle}
            />
            <button
              type="button"
              aria-label="Remove ID filter"
              onClick={() => setIds(ids.filter((_, j) => j !== i))}
              style={removeBtnStyle}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setIds([...ids, { key: "", value: "" }])}
          style={addBtnStyle}
        >
          <Plus size={14} aria-hidden="true" /> Add ID filter
        </button>
      </fieldset>

      {/* ----- data.<path> (op) value rows ----- */}
      <fieldset style={{ border: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <legend style={{ fontSize: 12, color: "var(--tb-mut)", padding: 0 }}>Data filters</legend>
        {data.map((row, i) => (
          <div key={i} data-testid="data-row" style={rowStyle}>
            <input
              type="text"
              aria-label="Data path"
              placeholder="path (e.g. latencyMs)"
              value={row.path}
              onChange={(e) =>
                setData(data.map((r, j) => (j === i ? { ...r, path: e.target.value } : r)))
              }
              style={inputStyle}
            />
            <select
              aria-label="Operator"
              value={row.op}
              onChange={(e) =>
                setData(
                  data.map((r, j) =>
                    j === i ? { ...r, op: e.target.value as DataFilter["op"] } : r,
                  ),
                )
              }
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              {DATA_OPS.map((op) => (
                <option key={op} value={op}>
                  {op === "eq" ? "=" : op === "gte" ? "≥" : "≤"} ({op})
                </option>
              ))}
            </select>
            <input
              type="text"
              aria-label="Data value"
              placeholder="value"
              value={row.value}
              onChange={(e) =>
                setData(data.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
              }
              style={inputStyle}
            />
            <button
              type="button"
              aria-label="Remove data filter"
              onClick={() => setData(data.filter((_, j) => j !== i))}
              style={removeBtnStyle}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setData([...data, { path: "", op: "eq", value: "" }])}
          style={addBtnStyle}
        >
          <Plus size={14} aria-hidden="true" /> Add data filter
        </button>
      </fieldset>
    </div>
  );
}
