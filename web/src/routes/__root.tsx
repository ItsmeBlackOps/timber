import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import { Settings as SettingsIcon } from "lucide-react";
import { AppSwitcher } from "@/components/AppSwitcher";
import { HealthDot } from "@/components/HealthDot";
import { SettingsDialog } from "@/components/SettingsDialog";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useEvents } from "@/hooks/useEvents";
import { useHealth } from "@/hooks/useHealth";
import { loadSettings } from "@/lib/settings";

// Top-bar shell (contracts C-F10 / spec §8.1): brand, primary nav, the
// AppSwitcher, the live health dot, theme toggle and a Settings trigger.
// Integration (F13): the AppSwitcher is driven by useEvents() and writes the
// `app` scope to the URL search (the single source of truth shared with
// Explore/Stats); the health dot reflects useHealth(); the Settings trigger
// mounts the real SettingsDialog and auto-opens on first run (no read key).

const navLinkBase: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  textDecoration: "none",
  color: "var(--tb-mut)",
  fontSize: 14,
};

export function RootShell() {
  const navigate = useNavigate();
  // App scope lives in the URL search (shared with Explore's filters). Read it
  // loosely (strict:false) so the shell works on every route.
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const currentApp =
    typeof search.app === "string" && search.app !== "" ? search.app : undefined;

  // Live health (C-F8) — polled, no read key required so the dot works pre-auth.
  const healthQuery = useHealth();
  // Known apps for the scope selector (C-F8); gated on a read key inside the hook.
  const eventsQuery = useEvents();
  const apps = Object.keys(eventsQuery.data?.apps ?? {});

  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  // First run (spec §8.1): no read key configured -> open Settings so the user
  // can paste one (otherwise every data hook stays disabled and nothing loads).
  useEffect(() => {
    if (loadSettings().readKey === "") setSettingsOpen(true);
  }, []);

  // The Explore 401 banner (and any other leaf) can ask the shell to open the
  // Settings dialog by firing a 'timber:open-settings' window event, since the
  // dialog's open state lives here rather than in those routes.
  useEffect(() => {
    const open = () => setSettingsOpen(true);
    window.addEventListener("timber:open-settings", open);
    return () => window.removeEventListener("timber:open-settings", open);
  }, []);

  function closeSettings() {
    setSettingsOpen(false);
    // Return focus to the trigger that opened the dialog (WCAG 2.4.3).
    settingsTriggerRef.current?.focus();
  }

  function setApp(app: string | undefined) {
    navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => {
        if (app === undefined) {
          const { app: _omit, ...rest } = prev;
          return rest;
        }
        return { ...prev, app };
      },
      replace: true,
    });
  }

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
          <AppSwitcher apps={apps} value={currentApp} onChange={setApp} />
          <HealthDot health={healthQuery.data} />
          <ThemeToggle />
          <button
            ref={settingsTriggerRef}
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

      <SettingsDialog open={settingsOpen} onClose={closeSettings} />
    </div>
  );
}
