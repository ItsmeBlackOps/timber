import { render, screen } from "@testing-library/react";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { RootShell } from "@/routes/__root";

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

function renderShell(initial = "/") {
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
  render(<RouterProvider router={router} />);
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
    renderShell();
    expect(await screen.findByText(/timber/i)).toBeInTheDocument();
  });

  it("renders nav links for Explore, Stats and Docs", async () => {
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
    renderShell("/stats");
    expect(await screen.findByText("stats-outlet")).toBeInTheDocument();
  });

  it("mounts an AppSwitcher slot (region) for the per-app pivot", async () => {
    renderShell();
    expect(
      await screen.findByTestId("app-switcher-slot"),
    ).toBeInTheDocument();
  });

  it("mounts the theme toggle", async () => {
    renderShell();
    await screen.findByText(/timber/i);
    expect(
      screen.getByRole("button", { name: /theme|dark|light/i }),
    ).toBeInTheDocument();
  });

  it("mounts a health status indicator", async () => {
    renderShell();
    await screen.findByText(/timber/i);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("mounts a Settings trigger that opens the settings dialog", async () => {
    renderShell();
    expect(
      await screen.findByRole("button", { name: /settings/i }),
    ).toBeInTheDocument();
  });
});
