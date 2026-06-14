// F13 — shared-fixture integration smoke for the Explore route.
//
// Unlike src/routes/explore.test.tsx (which stubs each endpoint per-case to probe
// URL→query wiring), this suite mounts the REAL Explore route against ONLY the
// shared default MSW handler set (test/handlers.ts → test/fixtures.ts, PRD §5.2
// events). It proves the shared handlers/fixtures render the console end-to-end —
// the three canonical events list, and the AI call's data.request/data.response
// pair drives the DetailPanel's two-pane inspector — with zero per-test network
// boilerplate. No `server.use(...)`: everything resolves through the baseline set.
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'

import { ExploreRoute } from '@/routes/explore'
import type { Settings } from '@/lib/settings'
import { aiRequestLog, cronRunLog, dbQueryLog } from './fixtures'

// Read key present so the data hooks are enabled (C-F8).
const settingsMock = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  DEFAULTS: {
    apiBaseUrl: '',
    readKey: 'tb_read',
    theme: 'system' as const,
    tailIntervalMs: 2000,
    userKeys: ['userEmail', 'userId'],
    slowMs: 300,
  } satisfies Settings,
}))
vi.mock('@/lib/settings', () => ({
  loadSettings: settingsMock.loadSettings,
  saveSettings: settingsMock.saveSettings,
  DEFAULTS: settingsMock.DEFAULTS,
}))

// jsdom shims the Explore subtree needs (matchMedia for theme, a fake
// IntersectionObserver + layout for the virtualized ResultsTable).
function installShims() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((media: string) => ({
      matches: false,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  )
  class MockIO {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  vi.stubGlobal('IntersectionObserver', MockIO as unknown as typeof IntersectionObserver)
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 520
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      return 900
    },
  })
}

function mountExplore(initialUrl = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  })
  const rootRoute = createRootRoute()
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: ExploreRoute,
  })
  const statsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/stats',
    component: () => <div>stats</div>,
  })
  const docsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/docs/$page',
    component: () => <div>docs</div>,
  })
  const routeTree = rootRoute.addChildren([indexRoute, statsRoute, docsRoute])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  })
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, queryClient }
}

beforeEach(() => {
  settingsMock.loadSettings.mockReturnValue({ ...settingsMock.DEFAULTS })
  settingsMock.saveSettings.mockImplementation((s) => ({ ...settingsMock.DEFAULTS, ...s }))
  installShims()
})

afterEach(() => {
  vi.unstubAllGlobals()
  // @ts-expect-error remove the test override
  delete HTMLElement.prototype.offsetHeight
  // @ts-expect-error remove the test override
  delete HTMLElement.prototype.offsetWidth
})

describe('Explore over the shared fixture handler set', () => {
  it('renders the three PRD §5.2 events from the default handlers', async () => {
    mountExplore('/')
    // All three canonical events surface with no per-test network setup.
    expect(await screen.findByText(aiRequestLog.message!)).toBeInTheDocument()
    expect(screen.getByText(dbQueryLog.message!)).toBeInTheDocument()
    expect(screen.getByText(cronRunLog.message!)).toBeInTheDocument()
  })

  it("shows the AI call's request/response panes in the detail inspector", async () => {
    const user = userEvent.setup()
    mountExplore('/')
    await user.click(await screen.findByText(aiRequestLog.message!))

    // ReqResView detected data.request / data.response -> two labeled panes.
    const request = await screen.findByRole('region', { name: /request/i })
    const response = await screen.findByRole('region', { name: /response/i })
    expect(request).toBeInTheDocument()
    expect(response).toBeInTheDocument()
    // The response pane carries the fixture's finishReason value.
    expect(within(response).getByText(/end_turn/)).toBeInTheDocument()

    // The userEmail id chip is pivotable (Filter by userEmail = anna@example.com).
    expect(
      screen.getByTitle(/filter by userEmail = anna@example\.com/i),
    ).toBeInTheDocument()
  })
})
