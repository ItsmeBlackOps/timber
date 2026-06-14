import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { DocsRoute } from "@/routes/docs.$page";
import { DOC_PAGES } from "@/content/docs";

// Mount the real DocsRoute under /docs/$page in a memory router so useParams
// resolves the slug, mirroring __root.test.tsx's setup. The index "/" exists so
// recipe links (to="/") have a valid target to navigate to.
function renderDocs(initial: string) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
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
    component: DocsRoute,
  });
  const routeTree = rootRoute.addChildren([indexRoute, statsRoute, docsRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe("DocsRoute", () => {
  it("renders a nav listing all eight docs pages", async () => {
    renderDocs("/docs/overview");
    const nav = await screen.findByRole("navigation", { name: /docs/i });
    expect(DOC_PAGES).toHaveLength(8);
    for (const page of DOC_PAGES) {
      expect(
        within(nav).getByRole("link", { name: page.title }),
      ).toBeInTheDocument();
    }
  });

  it("nav links point at the matching /docs/<slug>", async () => {
    renderDocs("/docs/overview");
    const nav = await screen.findByRole("navigation", { name: /docs/i });
    for (const page of DOC_PAGES) {
      expect(
        within(nav).getByRole("link", { name: page.title }),
      ).toHaveAttribute("href", `/docs/${page.slug}`);
    }
  });

  it("renders the page whose slug is in the URL", async () => {
    renderDocs("/docs/quickstart");
    // The Quickstart page heading (h1) is the page title.
    expect(
      await screen.findByRole("heading", { level: 1, name: /quickstart/i }),
    ).toBeInTheDocument();
  });

  it("falls back to the Overview page for an unknown slug", async () => {
    renderDocs("/docs/does-not-exist");
    expect(
      await screen.findByRole("heading", { level: 1, name: /overview/i }),
    ).toBeInTheDocument();
  });

  it("renders the Query API reference with all six endpoints documented", async () => {
    renderDocs("/docs/query-api");
    await screen.findByRole("heading", { level: 1, name: /query api/i });
    for (const path of [
      "/v1/logs",
      "/v1/stats",
      "/v1/events",
      "/v1/facets",
      "/v1/groupby",
      "/healthz",
    ]) {
      expect(screen.getAllByText(new RegExp(path)).length).toBeGreaterThan(0);
    }
  });

  it("builds a correct Console deep link for the 'all logs for a user' recipe", async () => {
    renderDocs("/docs/recipes");
    const link = await screen.findByTestId("recipe-link-all-logs-for-a-user");
    const href = link.getAttribute("href") ?? "";
    expect(href).toContain("ids.userEmail=");
    expect(href).toMatch(/^\/\?/); // targets Explore ("/") with a query string
  });

  it("recipe links target Explore or Stats with serialized filters", async () => {
    renderDocs("/docs/recipes");
    await screen.findByRole("heading", { level: 1, name: /recipes/i });
    // The cost-by-model recipe links to Stats.
    const costLink = screen.getByTestId("recipe-link-ai-cost-today-by-model");
    expect(costLink.getAttribute("href")).toMatch(/^\/stats/);
    // The slow-queries recipe encodes a data range filter for Explore.
    const slowLink = screen.getByTestId("recipe-link-slow-queries");
    expect(slowLink.getAttribute("href")).toContain("data.latencyMs__gte=300");
  });

  it("copies a code snippet via its CodeBlock copy button", async () => {
    // setup() first; userEvent installs its own clipboard stub, so override after.
    const user = userEvent.setup();
    const writeText = vi.fn<(t: string) => Promise<void>>(() =>
      Promise.resolve(),
    );
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderDocs("/docs/quickstart");
    await screen.findByRole("heading", { level: 1, name: /quickstart/i });

    const copyButtons = screen.getAllByRole("button", { name: /copy/i });
    expect(copyButtons.length).toBeGreaterThan(0);
    await user.click(copyButtons[0]);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(typeof writeText.mock.calls[0][0]).toBe("string");
  });
});
