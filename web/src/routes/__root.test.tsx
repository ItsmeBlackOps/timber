import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { RootShell } from "@/routes/__root";
import { saveSettings } from "@/lib/settings";

// jsdom lacks matchMedia; ThemeToggle (mounted in the shell) resolves theme via it.
function installMatchMedia(prefersDark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => ({
      matches: prefersDark,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

// The shell now calls useHealth() (TanStack Query) + mounts an AppSwitcher
// driven by useEvents(), so renders need a QueryClient. The shared MSW server
// (test/setup.ts) answers /healthz and /v1/events with the default fixtures.
function renderShell(initial = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const rootRoute = createRootRoute({ component: RootShell });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div>explore-outlet</div>,
  });
  const statsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/stats",
    component: () => <div>stats-outlet</div>,
  });
  const docsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/docs/$page",
    component: () => <div>docs-outlet</div>,
  });
  const routeTree = rootRoute.addChildren([
    indexRoute,
    statsRoute,
    docsRoute,
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  installMatchMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RootShell", () => {
  it("renders the Timber brand", async () => {
    saveSettings({ readKey: "tb_read" });
    renderShell();
    expect(await screen.findByText(/timber/i)).toBeInTheDocument();
  });

  it("renders nav links for Explore, Stats and Docs", async () => {
    saveSettings({ readKey: "tb_read" });
    renderShell();
    expect(
      await screen.findByRole("link", { name: /explore/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /stats/i })).toHaveAttribute(
      "href",
      "/stats",
    );
    const docs = screen.getByRole("link", { name: /docs/i });
    expect(docs.getAttribute("href")).toMatch(/^\/docs\//);
  });

  it("renders the active child route through the Outlet", async () => {
    saveSettings({ readKey: "tb_read" });
    renderShell("/stats");
    expect(await screen.findByText("stats-outlet")).toBeInTheDocument();
  });

  it("mounts the theme toggle", async () => {
    saveSettings({ readKey: "tb_read" });
    renderShell();
    await screen.findByText(/timber/i);
    expect(
      screen.getByRole("button", { name: /theme|dark|light/i }),
    ).toBeInTheDocument();
  });

  it("mounts a health status indicator", async () => {
    saveSettings({ readKey: "tb_read" });
    renderShell();
    await screen.findByText(/timber/i);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("mounts a Settings trigger that opens the settings dialog", async () => {
    saveSettings({ readKey: "tb_read" });
    const user = userEvent.setup();
    renderShell();
    const trigger = await screen.findByRole("button", { name: /settings/i });
    await user.click(trigger);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  // ---- F13 wiring: the real SettingsDialog (not the placeholder) ----------

  it("opens the REAL SettingsDialog (with a read-key field), not a placeholder", async () => {
    saveSettings({ readKey: "tb_read" });
    const user = userEvent.setup();
    renderShell();

    await user.click(await screen.findByRole("button", { name: /settings/i }));
    const dialog = await screen.findByRole("dialog");
    // The placeholder only ever rendered the text "Settings dialog loads here."
    expect(
      screen.queryByText(/settings dialog loads here/i),
    ).not.toBeInTheDocument();
    // The real dialog exposes the read-key input + a Save action.
    expect(within(dialog).getByLabelText(/read key/i)).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /save/i }),
    ).toBeInTheDocument();
    // Accessible modal semantics live on the panel, not a backdrop div.
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("auto-opens Settings on first run when no read key is configured", async () => {
    // localStorage cleared in beforeEach => hasReadKey() === false.
    renderShell();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(
      within(await screen.findByRole("dialog")).getByLabelText(/read key/i),
    ).toBeInTheDocument();
  });

  it("does NOT auto-open Settings when a read key is already configured", async () => {
    saveSettings({ readKey: "tb_read" });
    renderShell();
    await screen.findByText(/timber/i);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the Settings dialog on Escape", async () => {
    saveSettings({ readKey: "tb_read" });
    const user = userEvent.setup();
    renderShell();

    await user.click(await screen.findByRole("button", { name: /settings/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("returns focus to the Settings trigger after the dialog closes", async () => {
    saveSettings({ readKey: "tb_read" });
    const user = userEvent.setup();
    renderShell();

    const trigger = await screen.findByRole("button", { name: /settings/i });
    await user.click(trigger);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("opens Settings when a leaf route fires the 'timber:open-settings' event", async () => {
    // The Explore 401 banner resolves auth by asking the shell (which owns the
    // dialog state) to open Settings via this window event.
    saveSettings({ readKey: "tb_read" });
    renderShell();
    await screen.findByText(/timber/i);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("timber:open-settings"));
    });

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/read key/i)).toBeInTheDocument();
  });

  // ---- F13 wiring: live health (no longer permanently "unknown") ----------

  it("reflects live service health from /healthz (not a hardcoded 'unknown')", async () => {
    saveSettings({ readKey: "tb_read" });
    renderShell();
    // Default fixture HEALTH_RESPONSE is ok + mongo connected => data-health 'ok'.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveAttribute("data-health", "ok"),
    );
  });

  // ---- F13 wiring: AppSwitcher driven by /v1/events, app scope in the URL --

  it("mounts an AppSwitcher populated from /v1/events", async () => {
    saveSettings({ readKey: "tb_read" });
    renderShell();
    const appSelect = await screen.findByRole("combobox", { name: /app/i });
    // EVENTS_RESPONSE fixture apps: api, worker, scheduler (+ "all apps").
    await waitFor(() =>
      expect(
        within(appSelect).getByRole("option", { name: "api" }),
      ).toBeInTheDocument(),
    );
    expect(
      within(appSelect).getByRole("option", { name: "worker" }),
    ).toBeInTheDocument();
    expect(
      within(appSelect).getByRole("option", { name: "scheduler" }),
    ).toBeInTheDocument();
  });

  it("writes the chosen app to the URL search and reflects the current app", async () => {
    saveSettings({ readKey: "tb_read" });
    const user = userEvent.setup();
    const router = renderShell("/");
    const appSelect = await screen.findByRole("combobox", { name: /app/i });
    await waitFor(() =>
      expect(
        within(appSelect).getByRole("option", { name: "worker" }),
      ).toBeInTheDocument(),
    );

    await user.selectOptions(appSelect, "worker");
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ app: "worker" }),
    );
    // The control reflects the URL value.
    expect(screen.getByRole("combobox", { name: /app/i })).toHaveValue("worker");
  });

  it("clears the app param when 'all apps' is selected", async () => {
    saveSettings({ readKey: "tb_read" });
    const user = userEvent.setup();
    const router = renderShell("/?app=worker");
    const appSelect = await screen.findByRole("combobox", { name: /app/i });
    await waitFor(() => expect(appSelect).toHaveValue("worker"));

    await user.selectOptions(
      appSelect,
      within(appSelect).getByRole("option", { name: /all apps/i }),
    );
    await waitFor(() =>
      expect(router.state.location.search).not.toHaveProperty("app"),
    );
  });
});
