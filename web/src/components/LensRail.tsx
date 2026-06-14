// LensRail (contract C-F9) — left-hand rail of curated lenses + user saved
// views. Clicking a lens calls onApplyLens(lens) (the caller writes the URL).
// A small "save current view" form calls onSaveCurrent(name); each saved view
// row applies (onApplySaved) or deletes (onDeleteSaved).
import {
  AlertTriangle,
  Bookmark,
  Clock,
  Plus,
  Server,
  Sparkles,
  Timer,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

import { BUILTIN_LENSES } from "@/lib/views";
import type { Lens, SavedView } from "@/lib/views";

export interface LensRailProps {
  /** id of the currently applied lens, if any (highlights it). */
  active?: string;
  onApplyLens: (lens: Lens) => void;
  savedViews: SavedView[];
  onApplySaved: (view: SavedView) => void;
  /** Persist the current URL state under `name`. */
  onSaveCurrent: (name: string) => void;
  onDeleteSaved: (id: string) => void;
}

// Static name -> component map for the icons referenced by BUILTIN_LENSES.
// (lucide's runtime `icons` record omits some aliases like AlertTriangle, so a
// fixed map keeps this typecheck-clean and avoids dynamic-key misses.)
const ICONS: Record<string, LucideIcon> = {
  AlertTriangle,
  Sparkles,
  Users,
  Server,
  Timer,
  Clock,
};

const railButton = (activeState: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "7px 10px",
  textAlign: "left",
  borderRadius: 6,
  border: "1px solid transparent",
  background: activeState ? "var(--tb-2)" : "transparent",
  color: activeState ? "var(--tb-text)" : "var(--tb-mut)",
  cursor: "pointer",
  font: "inherit",
});

export function LensRail({
  active,
  onApplyLens,
  savedViews,
  onApplySaved,
  onSaveCurrent,
  onDeleteSaved,
}: LensRailProps) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");

  function submitSave() {
    const n = name.trim();
    if (n === "") return;
    onSaveCurrent(n);
    setName("");
    setSaving(false);
  }

  return (
    <nav
      aria-label="Lenses and saved views"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: 8,
        color: "var(--tb-text)",
      }}
    >
      <section>
        <h2
          style={{
            margin: "0 0 6px",
            padding: "0 6px",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: "var(--tb-mut)",
          }}
        >
          Lenses
        </h2>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          {BUILTIN_LENSES.map((lens) => {
            const Icon = ICONS[lens.icon] ?? Bookmark;
            const isActive = active === lens.id;
            return (
              <li key={lens.id}>
                <button
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => onApplyLens(lens)}
                  style={railButton(isActive)}
                >
                  <Icon size={16} aria-hidden="true" style={{ flex: "0 0 auto", color: "var(--tb-acc)" }} />
                  <span>{lens.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 6px",
            marginBottom: 6,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color: "var(--tb-mut)",
            }}
          >
            Saved views
          </h2>
          <button
            type="button"
            aria-label="Save current view"
            title="Save current view"
            onClick={() => setSaving((s) => !s)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 6px",
              borderRadius: 6,
              border: "1px solid var(--tb-border)",
              background: "var(--tb-surface)",
              color: "var(--tb-text)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            <Plus size={13} aria-hidden="true" /> Save
          </button>
        </div>

        {saving ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitSave();
            }}
            style={{ display: "flex", gap: 4, padding: "0 6px 6px" }}
          >
            <input
              type="text"
              aria-label="View name"
              placeholder="Name this view"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "5px 8px",
                borderRadius: 6,
                border: "1px solid var(--tb-border)",
                background: "var(--tb-surface)",
                color: "var(--tb-text)",
              }}
            />
            <button
              type="submit"
              style={{
                padding: "5px 10px",
                borderRadius: 6,
                border: "1px solid var(--tb-border)",
                background: "var(--tb-acc)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
              Save
            </button>
            <button
              type="button"
              aria-label="Cancel"
              onClick={() => {
                setSaving(false);
                setName("");
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "5px 7px",
                borderRadius: 6,
                border: "1px solid var(--tb-border)",
                background: "var(--tb-surface)",
                color: "var(--tb-mut)",
                cursor: "pointer",
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </form>
        ) : null}

        {savedViews.length === 0 ? (
          <p style={{ margin: 0, padding: "2px 6px", fontSize: 12, color: "var(--tb-mut)" }}>
            No saved views yet.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            {savedViews.map((view) => (
              <li
                key={view.id}
                style={{ display: "flex", alignItems: "center", gap: 4 }}
              >
                <button
                  type="button"
                  onClick={() => onApplySaved(view)}
                  style={{ ...railButton(false), flex: 1 }}
                >
                  <Bookmark size={15} aria-hidden="true" style={{ flex: "0 0 auto", color: "var(--tb-mut)" }} />
                  <span>{view.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${view.name}`}
                  title={`Delete ${view.name}`}
                  onClick={() => onDeleteSaved(view.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    padding: 5,
                    borderRadius: 6,
                    border: "1px solid transparent",
                    background: "transparent",
                    color: "var(--tb-mut)",
                    cursor: "pointer",
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </nav>
  );
}
