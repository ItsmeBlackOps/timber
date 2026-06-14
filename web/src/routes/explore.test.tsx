// F10 — Explore route, full render (contract C-F10).
//
// The URL is the single source of truth for filter state: search params hydrate
// the FilterBar, every filter edit / lens / pivot / group-by drill-in / FindBy
// rewrites the URL (and so refetches), live tail prepends+dedupes by _id, and a
// 401 surfaces the Banner. Network is mocked with MSW; the route is mounted in a
// real memory-history router (mirroring router.tsx's tree) so useSearch /
// useNavigate behave exactly as in production.
import { http, HttpResponse } from "msw";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

import { server } from "../../test/msw-server";
import { ExploreRoute } from "@/routes/explore";
import { filtersToParams } from "@/lib/filters";
import type { Filters } from "@/lib/filters";
import type { LogDoc, LogsResponse } from "@/lib/types";

// ---- settings: read key present so the data hooks are enabled ----------------
const settingsMock = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  DEFAULTS: {
    apiBaseUrl: "",
    readKey: "tb_read",
    theme: "system" as const,
    tailIntervalMs: 20,
    userKeys: ["userEmail", "userId"],
    slowMs: 300,
  },
}));
vi.mock("@/lib/settings", () => ({
  loadSettings: settingsMock.loadSettings,
  saveSettings: settingsMock.saveSettings,
  DEFAULTS: settingsMock.DEFAULTS,
}));

// ---- jsdom shims the children need ------------------------------------------
function installMatchMedia() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((media: string) => ({
      matches: false,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

// ResultsTable is virtualized (@tanstack/react-virtual) + uses an
// IntersectionObserver sentinel for load-more. jsdom has neither real layout nor
// IO, so feed both. Captured observers let a test fire the sentinel.
interface FakeIO {
  cb: IntersectionObserverCallback;
  elements: Element[];
  trigger: (isIntersecting: boolean) => void;
}
let observers: FakeIO[] = [];
function installIntersectionObserver() {
  observers = [];
  class MockIO {
    cb: IntersectionObserverCallback;
    elements: Element[] = [];
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb;
      const self = this as unknown as FakeIO;
      self.trigger = (isIntersecting: boolean) => {
        this.cb(
          this.elements.map(
            (el) =>
              ({
                isIntersecting,
                target: el,
                intersectionRatio: isIntersecting ? 1 : 0,
              }) as IntersectionObserverEntry,
          ),
          this as unknown as IntersectionObserver,
        );
      };
      observers.push(self);
    }
    observe(el: Element) {
      this.elements.push(el);
    }
    unobserve(el: Element) {
      this.elements = this.elements.filter((e) => e !== el);
    }
    disconnect() {
      this.elements = [];
    }
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", MockIO as unknown as typeof IntersectionObserver);
}
function installLayout() {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return 520;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 900;
    },
  });
}
function uninstallLayout() {
  // @ts-expect-error remove the test override
  delete HTMLElement.prototype.offsetHeight;
  // @ts-expect-error remove the test override
  delete HTMLElement.prototype.offsetWidth;
}

// ---- fixtures ----------------------------------------------------------------
function logDoc(id: string, over: Partial<LogDoc> = {}): LogDoc {
  return {
    _id: id,
    app: "api",
    env: "prod",
    event: "http.request",
    level: "info",
    message: `message ${id}`,
    ids: { userEmail: "anna@x.io" },
    data: { request: { method: "GET" }, response: { status: 200 } },
    receivedAt: "2026-06-14T05:00:00.000Z",
    expiresAt: "2026-07-14T05:00:00.000Z",
    ...over,
  };
}

// Capture every /v1/logs request's search params so assertions can inspect the
// URL→query wiring. `respond` decides the body per call (cursor pages, tail).
let logsCalls: URLSearchParams[] = [];
function handleLogs(respond: (p: URLSearchParams) => LogsResponse) {
  return http.get("/v1/logs", ({ request }) => {
    const p = new URL(request.url).searchParams;
    logsCalls.push(p);
    return HttpResponse.json(respond(p));
  });
}

function mountExplore(initialUrl = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: ExploreRoute,
  });
  const statsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/stats",
    component: () => <div>stats</div>,
  });
  const docsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/docs/$page",
    component: () => <div>docs</div>,
  });
  const routeTree = rootRoute.addChildren([indexRoute, statsRoute, docsRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

beforeEach(() => {
  settingsMock.loadSettings.mockReturnValue({ ...settingsMock.DEFAULTS });
  settingsMock.saveSettings.mockImplementation((s) => ({ ...settingsMock.DEFAULTS, ...s }));
  logsCalls = [];
  installMatchMedia();
  installIntersectionObserver();
  installLayout();
  // Discovery endpoints — present so FindBy / GroupBy children mount cleanly.
  server.use(
    http.get("/v1/events", () =>
      HttpResponse.json({ apps: { api: ["http.request"], worker: ["cron.run"] } }),
    ),
    http.get("/v1/facets", () =>
      HttpResponse.json({
        window: { from: "2026-06-13T05:00:00.000Z", to: "2026-06-14T05:00:00.000Z" },
        idsKeys: ["userEmail", "orgId"],
        dataPaths: ["latencyMs", "model"],
      }),
    ),
    http.get("/v1/groupby", () =>
      HttpResponse.json({
        by: "ids.userEmail",
        total: 0,
        groups: [],
        otherCount: 0,
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  uninstallLayout();
});

describe("ExploreRoute", () => {
  it("renders the core panels (filter bar, lenses, results)", async () => {
    server.use(handleLogs(() => ({ items: [logDoc("a")], nextCursor: null })));
    mountExplore("/");
    expect(await screen.findByText("message a")).toBeInTheDocument();
    // FilterBar's level chips + LensRail are present.
    expect(screen.getByRole("button", { name: /errors & warnings/i })).toBeInTheDocument();
  });

  it("hydrates filter state from the URL search params", async () => {
    server.use(handleLogs(() => ({ items: [logDoc("a")], nextCursor: null })));
    mountExplore("/?level=error&q=boom&app=worker");
    await screen.findByText("message a");

    // The logs query was issued with the URL's filters.
    await waitFor(() => {
      const last = logsCalls.at(-1)!;
      expect(last.get("level")).toBe("error");
      expect(last.get("q")).toBe("boom");
      expect(last.get("app")).toBe("worker");
    });

    // The free-text control reflects the URL value (controlled from search).
    const q = screen.getByLabelText(/message text|message/i) as HTMLInputElement;
    expect(q.value).toBe("boom");
  });

  it("editing a filter writes the URL and refetches", async () => {
    const user = userEvent.setup();
    server.use(handleLogs(() => ({ items: [logDoc("a")], nextCursor: null })));
    const { router } = mountExplore("/");
    await screen.findByText("message a");

    // Toggle the `error` level chip on.
    await user.click(screen.getByRole("button", { name: /^error$/i }));

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ level: "error" });
    });
    // A fresh logs request carried the new filter.
    await waitFor(() => {
      expect(logsCalls.some((p) => p.get("level") === "error")).toBe(true);
    });
  });

  it("applying a lens rewrites the URL filters", async () => {
    const user = userEvent.setup();
    server.use(handleLogs(() => ({ items: [logDoc("a")], nextCursor: null })));
    const { router } = mountExplore("/");
    await screen.findByText("message a");

    await user.click(screen.getByRole("button", { name: /errors & warnings/i }));

    await waitFor(() => {
      const lvl = String((router.state.location.search as Record<string, unknown>).level ?? "");
      // errors lens => warn,error (order-insensitive)
      expect(lvl.split(",").sort()).toEqual(["error", "warn"]);
    });
  });

  it("FindBy adds an ids.<key>= filter to the URL", async () => {
    const user = userEvent.setup();
    server.use(handleLogs(() => ({ items: [logDoc("a")], nextCursor: null })));
    const { router } = mountExplore("/");
    await screen.findByText("message a");

    const valueInput = screen.getByRole("textbox", { name: /value for/i });
    await user.type(valueInput, "bob@x.io");
    await user.click(screen.getByRole("button", { name: /^add$/i }));

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ "ids.userEmail": "bob@x.io" });
    });
    await waitFor(() => {
      expect(logsCalls.some((p) => p.get("ids.userEmail") === "bob@x.io")).toBe(true);
    });
  });

  it("pivoting on a detail leaf/id adds the matching filter", async () => {
    const user = userEvent.setup();
    server.use(handleLogs(() => ({ items: [logDoc("a")], nextCursor: null })));
    const { router } = mountExplore("/");
    await user.click(await screen.findByText("message a"));

    // The detail panel opened; pivot on the userEmail id chip (queried by its
    // title — the chip's accessible name is its text content "userEmail …").
    const chip = await screen.findByTitle(/filter by userEmail = anna@x\.io/i);
    await user.click(chip);

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ "ids.userEmail": "anna@x.io" });
    });
  });

  it("group-by drill-in adds the picked value as a filter", async () => {
    const user = userEvent.setup();
    server.use(handleLogs(() => ({ items: [logDoc("a")], nextCursor: null })));
    // groupby returns one bar to click.
    server.use(
      http.get("/v1/groupby", () =>
        HttpResponse.json({
          by: "ids.userEmail",
          total: 5,
          groups: [{ value: "carol@x.io", count: 5 }],
          otherCount: 0,
        }),
      ),
    );
    const { router } = mountExplore("/");
    await screen.findByText("message a");

    // Open the group-by panel (toggle), switch the dimension to ids.userEmail,
    // then click the bar (queried by its title).
    await user.click(screen.getByRole("button", { name: /group by|breakdown/i }));
    await user.selectOptions(
      screen.getByRole("combobox", { name: /group-by dimension/i }),
      "ids.userEmail",
    );
    const bar = await screen.findByTitle(/filter by carol@x\.io/i);
    await user.click(bar);

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ "ids.userEmail": "carol@x.io" });
    });
  });

  it("live-tail prepends new rows and dedupes by _id", async () => {
    const user = userEvent.setup();
    // Page 1: a,b. Tail polls page-1 (no cursor) and returns c + a (dup).
    let tailHit = 0;
    server.use(
      http.get("/v1/logs", ({ request }) => {
        const p = new URL(request.url).searchParams;
        logsCalls.push(p);
        const isTail = p.get("cursor") === null && tailHit > 0;
        if (p.get("cursor")) {
          return HttpResponse.json({ items: [], nextCursor: null });
        }
        const body = isTail
          ? { items: [logDoc("c"), logDoc("a")], nextCursor: null }
          : { items: [logDoc("a"), logDoc("b")], nextCursor: null };
        tailHit += 1;
        return HttpResponse.json(body);
      }),
    );
    mountExplore("/");
    await screen.findByText("message a");
    expect(screen.getByText("message b")).toBeInTheDocument();

    // Turn live tail on.
    await user.click(screen.getByRole("button", { name: /live|tail/i }));

    // The new row appears; the duplicate `a` is not doubled.
    expect(await screen.findByText("message c")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByText("message a")).toHaveLength(1);
    });
  });

  it("load-more appends the next cursor page", async () => {
    const pages: Record<string, LogsResponse> = {
      "": { items: [logDoc("a"), logDoc("b")], nextCursor: "cur2" },
      cur2: { items: [logDoc("c")], nextCursor: null },
    };
    server.use(
      http.get("/v1/logs", ({ request }) => {
        const p = new URL(request.url).searchParams;
        logsCalls.push(p);
        const cursor = p.get("cursor") ?? "";
        return HttpResponse.json(pages[cursor]);
      }),
    );
    // Seed page 1 into the infinite-query cache so ResultsTable mounts with rows
    // (and its load-more sentinel) on the first render — this isolates the
    // route's onLoadMore -> fetchNextPage -> append wiring from ResultsTable's
    // mount-time observer attachment.
    const emptyFilters: Filters = { levels: [], ids: [], data: [] };
    const logsKey = ["logs", filtersToParams(emptyFilters).toString()];
    const { queryClient } = mountExplore("/");
    queryClient.setQueryData(logsKey, {
      pages: [pages[""]],
      pageParams: [null],
    });

    await screen.findByText("message a");
    expect(screen.getByText("message b")).toBeInTheDocument();

    // Fire the load-more sentinel — fetches cur2 and appends [c].
    observers.forEach((o) => o.trigger(true));

    expect(await screen.findByText("message c")).toBeInTheDocument();
    // The original rows are still present (appended, not replaced).
    expect(screen.getByText("message a")).toBeInTheDocument();
  });

  it("shows the 401 Banner when the logs query is unauthorized", async () => {
    server.use(
      http.get("/v1/logs", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );
    mountExplore("/");
    expect(
      await screen.findByText(/unauthorized|read key/i),
    ).toBeInTheDocument();
  });
});
