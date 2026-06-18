// F10 — Explore route, full render (contract C-F10).
//
// The URL is the single source of truth for filter state: search params hydrate
// the FilterBar, every filter edit / lens / pivot / group-by drill-in / FindBy
// rewrites the URL (and so refetches), live tail prepends+dedupes by _id, and a
// 401 surfaces the Banner. Network is mocked with MSW; the route is mounted in a
// real memory-history router (mirroring router.tsx's tree) so useSearch /
// useNavigate behave exactly as in production.
import { http, HttpResponse } from "msw";
import { render, screen, waitFor, within } from "@testing-library/react";
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
import { filtersToParams, parseSearch, stringifySearch } from "@/lib/filters";
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
  // Reactive store fns used by useSettings (the data-hook gate + viewCfg).
  getSnapshot: () => settingsMock.loadSettings(),
  subscribe: () => () => {},
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
    // Mirror production router.tsx: opaque-string search (de)serialization so the
    // test exercises the same URL boundary as the app.
    parseSearch,
    stringifySearch,
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

    const valueInput = screen.getByRole("combobox", { name: /value for/i });
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

  // ---- URL search values are opaque strings (no router JSON coercion) --------
  it("treats a bookmarked q=null as the literal string (router doesn't drop it)", async () => {
    server.use(handleLogs(() => ({ items: [logDoc("a")], nextCursor: null })));
    // Hand-crafted / shared URL: ?q=null. With the default router parser this
    // becomes JS null and the q param is dropped from the request. The opaque
    // string parser keeps it as the literal regex "null".
    mountExplore("/?q=null");
    await screen.findByText("message a");
    await waitFor(() => {
      expect(logsCalls.some((p) => p.get("q") === "null")).toBe(true);
    });
    // The control reflects the literal value.
    const q = screen.getByLabelText(/message text|message/i) as HTMLInputElement;
    expect(q.value).toBe("null");
  });

  it("treats a numeric-looking bookmarked value as a string (data.amount=42)", async () => {
    server.use(handleLogs(() => ({ items: [logDoc("a")], nextCursor: null })));
    mountExplore("/?data.amount=42");
    await screen.findByText("message a");
    await waitFor(() => {
      expect(logsCalls.some((p) => p.get("data.amount") === "42")).toBe(true);
    });
  });

  // ---- live-tail buffer: reset on filter change (no cross-filter leak) -------
  it("live-tail buffer resets on filter change — stale rows don't leak", async () => {
    const user = userEvent.setup();
    // Page 1 with no env filter -> [a, b]; a tail poll adds tail-only row `t1`.
    // After env=stg is applied the server returns only [b]; the tail-captured
    // `t1` (seen under the no-env filter) must NOT survive into the new view.
    let tailHit = 0;
    server.use(
      http.get("/v1/logs", ({ request }) => {
        const p = new URL(request.url).searchParams;
        logsCalls.push(p);
        if (p.get("cursor")) return HttpResponse.json({ items: [], nextCursor: null });
        const env = p.get("env");
        if (env === "stg") {
          return HttpResponse.json({ items: [logDoc("b", { env: "stg" })], nextCursor: null });
        }
        // no env filter: base page + a tail-only row on the 2nd+ hit.
        const isTail = tailHit > 0;
        tailHit += 1;
        return HttpResponse.json(
          isTail
            ? { items: [logDoc("t1"), logDoc("a")], nextCursor: null }
            : { items: [logDoc("a"), logDoc("b")], nextCursor: null },
        );
      }),
    );
    mountExplore("/");
    await screen.findByText("message a");

    // Turn live tail on and let it capture the tail-only row.
    await user.click(screen.getByRole("button", { name: /live|tail/i }));
    expect(await screen.findByText("message t1")).toBeInTheDocument();

    // Now narrow the filter: type env=stg. The new query returns only `b`.
    const envInput = screen.getByLabelText(/environment/i);
    await user.type(envInput, "stg");

    await waitFor(() => {
      expect(logsCalls.some((p) => p.get("env") === "stg")).toBe(true);
    });
    // The stale tail row from the previous filter must be gone.
    await waitFor(() => {
      expect(screen.queryByText("message t1")).not.toBeInTheDocument();
    });
  });

  // Same leak guard, harsher: the NEW filter's page is EMPTY. The prior test's
  // env=stg page returns `b`, whose presence could mask a leaked tail row in the
  // dedupe; an empty page removes that masking, so a leaked `tailNoEnv` would be
  // visibly rendered. (Regression guard for the reviewer's tailNoEnv repro.)
  it("live-tail buffer reset survives an empty new-filter page (no masking)", async () => {
    const user = userEvent.setup();
    let tailHit = 0;
    server.use(
      http.get("/v1/logs", ({ request }) => {
        const p = new URL(request.url).searchParams;
        logsCalls.push(p);
        if (p.get("cursor")) return HttpResponse.json({ items: [], nextCursor: null });
        if (p.get("env") === "stg") {
          // Empty stg view — nothing to mask a leaked tail row.
          return HttpResponse.json({ items: [], nextCursor: null });
        }
        const isTail = tailHit > 0;
        tailHit += 1;
        return HttpResponse.json(
          isTail
            ? { items: [logDoc("tailNoEnv"), logDoc("a")], nextCursor: null }
            : { items: [logDoc("a"), logDoc("b")], nextCursor: null },
        );
      }),
    );
    mountExplore("/");
    await screen.findByText("message a");
    await user.click(screen.getByRole("button", { name: /live|tail/i }));
    expect(await screen.findByText("message tailNoEnv")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/environment/i), "stg");
    await waitFor(() => {
      expect(logsCalls.some((p) => p.get("env") === "stg")).toBe(true);
    });
    // Let several tail intervals elapse so a buggy buffer would re-prepend.
    await new Promise((r) => setTimeout(r, 120));
    expect(screen.queryByText("message tailNoEnv")).not.toBeInTheDocument();
  });

  // A->B->A round trip: a tail row captured under app=api must not bleed into
  // app=worker, and worker's tail row must not survive the return to api. The
  // buffer is keyed by filterKey, so each scope keeps its own tail rows.
  it("live-tail buffer keeps each filter's tail rows isolated across an A->B->A switch", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/v1/logs", ({ request }) => {
        const p = new URL(request.url).searchParams;
        logsCalls.push(p);
        if (p.get("cursor")) return HttpResponse.json({ items: [], nextCursor: null });
        if ((p.get("app") ?? "") === "worker") {
          return HttpResponse.json({
            items: [logDoc("wtail", { app: "worker" }), logDoc("wbase", { app: "worker" })],
            nextCursor: null,
          });
        }
        return HttpResponse.json({ items: [logDoc("atail"), logDoc("abase")], nextCursor: null });
      }),
    );
    mountExplore("/?app=api");
    await screen.findByText("message abase");
    await user.click(screen.getByRole("button", { name: /live|tail/i }));
    expect(await screen.findByText("message atail")).toBeInTheDocument();

    // Switch to worker (AppSwitcher writes app=worker to the URL).
    const appSel = screen.getByLabelText(/^app$/i);
    await user.selectOptions(appSel, "worker");
    await screen.findByText("message wbase");
    await waitFor(() => expect(screen.queryByText("message atail")).not.toBeInTheDocument());

    // Switch back to api: worker's tail row must NOT bleed in.
    await user.selectOptions(appSel, "api");
    await screen.findByText("message abase");
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.queryByText("message wtail")).not.toBeInTheDocument();
  });

  // A row that is tail-only under filter A but arrives in the PAGE under filter
  // B (promoted) must render exactly once after the switch — not page + a stale
  // tail copy. Guards the dedupe in both the buffer-reset effect and the `items`
  // merge memo.
  it("live-tail: a tail-only row promoted into the page under a new filter isn't duplicated", async () => {
    const user = userEvent.setup();
    let apiTail = 0;
    server.use(
      http.get("/v1/logs", ({ request }) => {
        const p = new URL(request.url).searchParams;
        logsCalls.push(p);
        if (p.get("cursor")) return HttpResponse.json({ items: [], nextCursor: null });
        if ((p.get("level") ?? "") === "error") {
          // Under level=error, `shared` is a PAGE row.
          return HttpResponse.json({
            items: [logDoc("shared", { level: "error" }), logDoc("ebase", { level: "error" })],
            nextCursor: null,
          });
        }
        // Under no level filter, `shared` arrives only via the TAIL.
        const isTail = apiTail > 0;
        apiTail += 1;
        return HttpResponse.json(
          isTail
            ? { items: [logDoc("shared"), logDoc("abase")], nextCursor: null }
            : { items: [logDoc("abase")], nextCursor: null },
        );
      }),
    );
    mountExplore("/");
    await screen.findByText("message abase");
    await user.click(screen.getByRole("button", { name: /live|tail/i }));
    expect(await screen.findByText("message shared")).toBeInTheDocument();

    // Filter to level=error via the "error" chip (scope to the Levels group so
    // we don't hit the LensRail's "Errors & warnings" preset).
    const levels = screen.getByRole("group", { name: /levels/i });
    await user.click(within(levels).getByRole("button", { name: /^error$/i }));
    await waitFor(() => expect(logsCalls.some((p) => p.get("level") === "error")).toBe(true));

    await new Promise((r) => setTimeout(r, 80));
    // Exactly one `shared` (the page row) — no stale tail copy from filter A.
    await waitFor(() => expect(screen.getAllByText("message shared")).toHaveLength(1));
  });

  // ---- live-tail buffer: bounded (no unbounded growth) ----------------------
  it("live-tail buffer is bounded — oldest tail-only rows are evicted", async () => {
    const user = userEvent.setup();
    // Each tail poll returns a single brand-new id (t1, t2, ...). With a bound of
    // N, after many polls only the most-recent N tail-only rows are retained.
    let n = 0;
    server.use(
      http.get("/v1/logs", ({ request }) => {
        const p = new URL(request.url).searchParams;
        logsCalls.push(p);
        if (p.get("cursor")) return HttpResponse.json({ items: [], nextCursor: null });
        if (n === 0) {
          n += 1;
          return HttpResponse.json({ items: [logDoc("base")], nextCursor: null });
        }
        n += 1;
        return HttpResponse.json({ items: [logDoc(`t${n}`)], nextCursor: null });
      }),
    );
    mountExplore("/");
    await screen.findByText("message base");
    await user.click(screen.getByRole("button", { name: /live|tail/i }));

    // Wait until many distinct tail ids have been polled (interval is 20ms).
    await waitFor(
      () => {
        // a late id is present...
        expect(screen.queryByText(/message t1[0-9]/)).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    // ...and the very first tail id has been evicted (bounded buffer).
    await waitFor(
      () => {
        expect(screen.queryByText("message t2")).not.toBeInTheDocument();
      },
      { timeout: 4000 },
    );
  });

  // ---- "Add ID filter" / "Add data filter" yield an editable row ------------
  it("Add ID filter / Add data filter add an editable row in Explore", async () => {
    const user = userEvent.setup();
    server.use(handleLogs(() => ({ items: [logDoc("a")], nextCursor: null })));
    mountExplore("/");
    await screen.findByText("message a");

    await user.click(screen.getByRole("button", { name: /add id filter/i }));
    await waitFor(() => {
      expect(screen.getAllByTestId("id-row")).toHaveLength(1);
    });

    await user.click(screen.getByRole("button", { name: /add data filter/i }));
    await waitFor(() => {
      expect(screen.getAllByTestId("data-row")).toHaveLength(1);
    });

    // The new id row is editable and, once both fields are filled, reaches the URL.
    const keyInput = screen.getByLabelText("ID key");
    const valInput = screen.getByLabelText("ID value");
    await user.type(keyInput, "orgId");
    await user.type(valInput, "acme");
    await waitFor(() => {
      expect(logsCalls.some((p) => p.get("ids.orgId") === "acme")).toBe(true);
    });
  });

  // ---- facets discovery window is stable (no refetch churn) ------------------
  it("does not churn the /v1/facets query key while idle with live tail on", async () => {
    const user = userEvent.setup();
    const facetsWindows = new Set<string>();
    server.use(
      handleLogs(() => ({ items: [logDoc("a")], nextCursor: null })),
      http.get("/v1/facets", ({ request }) => {
        const p = new URL(request.url).searchParams;
        facetsWindows.add(`${p.get("from")}..${p.get("to")}`);
        return HttpResponse.json({
          window: { from: "2026-06-13T05:00:00.000Z", to: "2026-06-14T05:00:00.000Z" },
          idsKeys: ["userEmail"],
          dataPaths: ["latencyMs"],
        });
      }),
    );
    mountExplore("/");
    await screen.findByText("message a");
    // Turn live tail on so re-renders happen every 20ms.
    await user.click(screen.getByRole("button", { name: /live|tail/i }));

    // Let several tail polls (and re-renders) elapse.
    await new Promise((r) => setTimeout(r, 300));

    // A stable discovery window means at most ONE distinct facets window despite
    // many re-renders. (Before the fix, every render produced a new ISO `to`.)
    expect(facetsWindows.size).toBeLessThanOrEqual(1);
  });

  // ---- selected detail panel persists across a filter change ----------------
  it("keeps the detail panel open when the selected row leaves the list", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/v1/logs", ({ request }) => {
        const p = new URL(request.url).searchParams;
        logsCalls.push(p);
        if (p.get("cursor")) return HttpResponse.json({ items: [], nextCursor: null });
        // env=stg returns a different row that does not include `a`.
        if (p.get("env") === "stg") {
          return HttpResponse.json({ items: [logDoc("b", { env: "stg" })], nextCursor: null });
        }
        return HttpResponse.json({ items: [logDoc("a")], nextCursor: null });
      }),
    );
    mountExplore("/");
    // Open the detail panel for row `a`. Scope to the panel's own header — the
    // `level-chip` testid is shared with the list rows (LogRow), so assert on
    // `detail-header`, which is unique to DetailPanel.
    await user.click(await screen.findByText("message a"));
    await screen.findByTestId("detail-header");

    // Change the filter so `a` is no longer in the loaded list.
    const envInput = screen.getByLabelText(/environment/i);
    await user.type(envInput, "stg");
    await waitFor(() => {
      expect(logsCalls.some((p) => p.get("env") === "stg")).toBe(true);
    });

    // The panel must not silently blink out: either it still shows `a`'s detail,
    // or it cleanly closes. It must NOT vanish while leaving a dangling state —
    // we assert it stays mounted (last-selected doc retained).
    expect(screen.getByTestId("detail-header")).toBeInTheDocument();
  });

  // ---- DetailPanel in-document state resets when switching rows --------------
  it("resets DetailPanel in-document search when a different row is selected", async () => {
    const user = userEvent.setup();
    server.use(
      handleLogs(() => ({
        items: [logDoc("a"), logDoc("b", { message: "message b" })],
        nextCursor: null,
      })),
    );
    mountExplore("/");
    await user.click(await screen.findByText("message a"));

    // Type into the DetailPanel's in-document search box.
    const findBox = await screen.findByRole("searchbox", { name: /search within document/i });
    await user.type(findBox, "method");
    expect((findBox as HTMLInputElement).value).toBe("method");

    // Select a different row; the search box must reset (fresh panel instance).
    await user.click(screen.getByText("message b"));
    await waitFor(() => {
      const box = screen.getByRole("searchbox", { name: /search within document/i }) as HTMLInputElement;
      expect(box.value).toBe("");
    });
  });
});
