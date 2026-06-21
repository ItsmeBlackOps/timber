import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { useProjects, useEvents } from "@/hooks";
import { ApiError } from "@/lib/types";
import type { Project } from "@/lib/types";

export interface ManageProjectsDialogProps {
  open: boolean;
  onClose: () => void;
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--tb-mut)",
  marginBottom: 4,
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "7px 10px",
  borderRadius: 6,
  border: "1px solid var(--tb-border)",
  background: "var(--tb-bg)",
  color: "var(--tb-text)",
  fontSize: 14,
};

const ghostBtnStyle: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--tb-border)",
  background: "var(--tb-surface)",
  color: "var(--tb-text)",
  cursor: "pointer",
  fontSize: 13,
};

const accentBtnStyle: React.CSSProperties = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid var(--tb-acc)",
  background: "var(--tb-acc)",
  color: "var(--tb-bg)",
  cursor: "pointer",
  fontWeight: 600,
};

const chipStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid var(--tb-border)",
  background: "var(--tb-bg)",
  color: "var(--tb-text)",
  fontSize: 12,
};

/** Tabbable elements inside the panel, in DOM order (skips disabled/hidden). */
function focusableEls(panel: HTMLElement): HTMLElement[] {
  const sel =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(panel.querySelectorAll<HTMLElement>(sel)).filter(
    (el) =>
      !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Manage Projects editor (spec: Projects + per-project lenses). Lists the
 * configured projects from /v1/projects and lets the operator create, edit and
 * delete them, picking the services (apps) each one groups. Service checkboxes
 * are seeded from the known apps in /v1/events, and a free-text field lets a
 * not-yet-seen service be added. Mutations come from useProjects() (TanStack
 * Query) which invalidates the list on success, so the dialog reflects changes
 * in place. It stays open after create/delete; only Close / Escape / overlay
 * click dismiss it.
 *
 * The modal scaffold (focus trap, aria-modal, Escape) mirrors SettingsDialog.
 */
export function ManageProjectsDialog({
  open,
  onClose,
}: ManageProjectsDialogProps) {
  const ids = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  const { query, create, update, remove } = useProjects();
  const projects = query.data?.projects ?? [];
  const knownApps = Object.keys(useEvents().data?.apps ?? {});

  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [apps, setApps] = useState<string[]>([]);
  const [newApp, setNewApp] = useState("");

  function reset() {
    setEditingSlug(null);
    setName("");
    setApps([]);
    setNewApp("");
  }
  function startEdit(p: Project) {
    setEditingSlug(p.slug);
    setName(p.name);
    setApps(p.apps);
    setNewApp("");
  }
  function toggleApp(a: string) {
    setApps((xs) => (xs.includes(a) ? xs.filter((x) => x !== a) : [...xs, a]));
  }
  function addNewApp() {
    const a = newApp.trim();
    if (a && !apps.includes(a)) setApps((xs) => [...xs, a]);
    setNewApp("");
  }

  const pending = create.isPending || update.isPending;
  function submit() {
    if (name.trim() === "") return;
    const onDone = { onSuccess: () => reset() };
    if (editingSlug)
      update.mutate({ slug: editingSlug, name: name.trim(), apps }, onDone);
    else create.mutate({ name: name.trim(), apps }, onDone);
  }

  const err = (create.error ?? update.error) as unknown;
  const errMsg =
    err instanceof ApiError && err.status === 409
      ? "A project with that name already exists."
      : err
        ? "Could not save the project. Please try again."
        : null;

  // Focus management for the modal (WCAG 2.4.3): on open, remember what had
  // focus and move focus into the dialog; on close, restore it. The Tab-cycle
  // trap lives in the panel's onKeyDown so focus cannot leave the dialog.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) {
      const first = focusableEls(panel)[0];
      (first ?? panel).focus();
    }
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const els = focusableEls(panel);
    if (els.length === 0) {
      e.preventDefault();
      return;
    }
    const first = els[0];
    const last = els[els.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !panel.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !panel.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  const titleId = `${ids}-title`;

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "color-mix(in srgb, var(--tb-bg) 70%, transparent)",
        zIndex: 50,
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          width: "min(520px, 92vw)",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 20,
          borderRadius: 12,
          border: "1px solid var(--tb-border)",
          background: "var(--tb-surface)",
          color: "var(--tb-text)",
          boxShadow: "0 10px 40px rgba(0,0,0,0.35)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <h2 id={titleId} style={{ margin: 0, fontSize: 18 }}>
            Projects
          </h2>
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 30,
              height: 30,
              borderRadius: 6,
              border: "1px solid var(--tb-border)",
              background: "var(--tb-surface)",
              color: "var(--tb-mut)",
              cursor: "pointer",
            }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <section style={{ marginBottom: 20 }}>
          <h3
            style={{
              margin: "0 0 8px",
              fontSize: 12,
              fontWeight: 600,
              color: "var(--tb-mut)",
            }}
          >
            Your projects
          </h3>
          {projects.length === 0 ? (
            <p style={{ margin: 0, fontSize: 14, color: "var(--tb-mut)" }}>
              No projects yet.
            </p>
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {projects.map((p) => (
                <li
                  key={p.slug}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: "1px solid var(--tb-border)",
                    background: "var(--tb-bg)",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</div>
                    <div style={{ fontSize: 12, color: "var(--tb-mut)" }}>
                      {p.apps.join(", ") || "no services"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      style={ghostBtnStyle}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Delete project "${p.name}"?`))
                          remove.mutate(p.slug);
                      }}
                      style={ghostBtnStyle}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          style={{
            paddingTop: 16,
            borderTop: "1px solid var(--tb-border)",
            display: "flex",
            flexDirection: "column",
            gap: 14,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            {editingSlug ? "Edit project" : "New project"}
          </h3>

          <div>
            <label htmlFor={`${ids}-name`} style={labelStyle}>
              Name
            </label>
            <input
              id={`${ids}-name`}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme"
              style={fieldStyle}
            />
          </div>

          <div>
            <span style={labelStyle}>Services</span>
            {knownApps.length > 0 ? (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "6px 14px",
                  marginBottom: 8,
                }}
              >
                {knownApps.map((a) => (
                  <label
                    key={a}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 13,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={apps.includes(a)}
                      onChange={() => toggleApp(a)}
                    />
                    {a}
                  </label>
                ))}
              </div>
            ) : null}

            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="text"
                aria-label="Add a service"
                value={newApp}
                onChange={(e) => setNewApp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addNewApp();
                  }
                }}
                placeholder="service name"
                style={fieldStyle}
              />
              <button
                type="button"
                onClick={addNewApp}
                style={{ ...ghostBtnStyle, flexShrink: 0 }}
              >
                Add
              </button>
            </div>

            {apps.length > 0 ? (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginTop: 8,
                }}
              >
                {apps.map((a) => (
                  <span key={a} style={chipStyle}>
                    {a}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          {errMsg && (
            <p
              role="alert"
              style={{ margin: 0, fontSize: 12, color: "var(--tb-error)" }}
            >
              {errMsg}
            </p>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            {editingSlug ? (
              <button type="button" onClick={reset} style={ghostBtnStyle}>
                Cancel edit
              </button>
            ) : null}
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              style={
                pending ? { ...accentBtnStyle, opacity: 0.6 } : accentBtnStyle
              }
            >
              {editingSlug ? "Save" : "Create project"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
