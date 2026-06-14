import { useState } from "react";
import { Link, Outlet } from "@tanstack/react-router";
import { Settings as SettingsIcon } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { HealthDot } from "@/components/HealthDot";
import type { Health } from "@/lib/types";

// Top-bar shell (contracts C-F10 / spec §8.1): brand, primary nav, an
// AppSwitcher slot, the health dot, theme toggle and a Settings trigger.
// The AppSwitcher (F6), live health hook (F5/useHealth) and SettingsDialog (F12)
// are wired in by the integration task (F13); this shell exposes their mount
// points without importing those not-yet-built modules.

const navLinkBase: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  textDecoration: "none",
  color: "var(--tb-mut)",
  fontSize: 14,
};

export function RootShell() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Live health is injected by F13 via useHealth(); until then the dot shows
  // the "unknown" state.
  const health: Health | undefined = undefined;

  return (
    <div
      style={{
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--tb-bg)",
        color: "var(--tb-text)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "10px 16px",
          borderBottom: "1px solid var(--tb-border)",
          background: "var(--tb-surface)",
        }}
      >
        <Link
          to="/"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            textDecoration: "none",
            color: "var(--tb-text)",
            fontWeight: 700,
            fontSize: 16,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 10,
              height: 16,
              borderRadius: 2,
              background: "var(--tb-acc)",
              display: "inline-block",
            }}
          />
          <span>Timber</span>
        </Link>

        <nav
          aria-label="Primary"
          style={{ display: "flex", gap: 4, marginInlineStart: 8 }}
        >
          <Link
            to="/"
            activeOptions={{ exact: true }}
            style={navLinkBase}
            activeProps={{
              style: {
                ...navLinkBase,
                color: "var(--tb-text)",
                background: "var(--tb-2)",
              },
            }}
          >
            Explore
          </Link>
          <Link
            to="/stats"
            style={navLinkBase}
            activeProps={{
              style: {
                ...navLinkBase,
                color: "var(--tb-text)",
                background: "var(--tb-2)",
              },
            }}
          >
            Stats
          </Link>
          <Link
            to="/docs/$page"
            params={{ page: "overview" }}
            style={navLinkBase}
            activeProps={{
              style: {
                ...navLinkBase,
                color: "var(--tb-text)",
                background: "var(--tb-2)",
              },
            }}
          >
            Docs
          </Link>
        </nav>

        <div
          style={{
            marginInlineStart: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          {/* AppSwitcher mounts here (F6 / wired by F13). */}
          <div data-testid="app-switcher-slot" aria-label="App switcher" />
          <HealthDot health={health} />
          <ThemeToggle />
          <button
            type="button"
            aria-label="Settings"
            title="Settings"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 32,
              height: 32,
              borderRadius: 6,
              border: "1px solid var(--tb-border)",
              background: "var(--tb-surface)",
              color: "var(--tb-text)",
              cursor: "pointer",
            }}
          >
            <SettingsIcon size={16} aria-hidden="true" />
          </button>
        </div>
      </header>

      <main style={{ flex: 1, minHeight: 0 }}>
        <Outlet />
      </main>

      {/* SettingsDialog (F12) replaces this placeholder via F13. Kept minimal so
          the trigger is functional in isolation without importing that module. */}
      {settingsOpen ? (
        <div
          role="dialog"
          aria-label="Settings"
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "color-mix(in srgb, var(--tb-bg) 70%, transparent)",
          }}
          onClick={() => setSettingsOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              padding: 20,
              borderRadius: 10,
              border: "1px solid var(--tb-border)",
              background: "var(--tb-surface)",
              color: "var(--tb-text)",
              maxWidth: 420,
            }}
          >
            <p style={{ margin: 0 }}>Settings dialog loads here.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
