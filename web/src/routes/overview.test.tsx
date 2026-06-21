// Task 6 — Project Overview dashboard (/overview).
//
// Full-render tests with MSW: the route reads `project` from the URL, renders the
// six lens cards, and scopes every data query (/v1/stats, /v1/groupby, /v1/jobs)
// to that project slug. The harness mirrors stats.test.tsx — a memory router that
// mounts the real OverviewRoute plus stub targets for its drill-in <Link>s, a
// QueryClient, and a settings mock with a non-empty read key so the data hooks
// are enabled.
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'

import { server } from '../../test/msw-server'
import { GROUPBY_RESPONSE, JOBS_RESPONSE, STATS_RESPONSE } from '../../test/fixtures'
import type { Settings } from '@/lib/settings'
import { OverviewRoute } from '@/routes/overview'

// The data hooks read base URL + read key from settings (C-F5). Mock the module
// so this suite depends only on the C-F5 shape and the queries are enabled.
const settingsMock = vi.hoisted(() => ({ loadSettings: vi.fn() }))
vi.mock('@/lib/settings', () => ({
  loadSettings: settingsMock.loadSettings,
  getSnapshot: () => settingsMock.loadSettings(),
  subscribe: () => () => {},
}))

const BASE_SETTINGS: Settings = {
  apiBaseUrl: '',
  readKey: 'tb_read',
  theme: 'system',
  tailIntervalMs: 2000,
  userKeys: ['userEmail', 'userId'],
  slowMs: 300,
}

function setSettings(partial: Partial<Settings> = {}): void {
  settingsMock.loadSettings.mockReturnValue({ ...BASE_SETTINGS, ...partial })
}

/** Mount the real OverviewRoute under a memory router at the given URL. */
function renderOverview(initial = '/overview') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const overviewRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/overview',
    component: OverviewRoute,
  })
  // Stub targets so the cards' drill-in <Link>s resolve.
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div>home</div>,
  })
  const statsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/stats',
    component: () => <div>stats</div>,
  })
  const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/jobs',
    component: () => <div>jobs</div>,
  })
  const routeTree = rootRoute.addChildren([indexRoute, overviewRoute, statsRoute, jobsRoute])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, ...utils }
}

beforeEach(() => {
  setSettings()
  vi.restoreAllMocks()
})

describe('OverviewRoute', () => {
  test('renders the six lens cards', async () => {
    renderOverview('/overview?project=acme')
    for (const id of ['errors', 'ai-usage', 'by-user', 'by-service', 'slow-ops', 'cron']) {
      expect(await screen.findByTestId(`overview-${id}`)).toBeInTheDocument()
    }
  })

  test('scopes its queries to the project slug', async () => {
    const seen: Record<string, string | null> = {}
    server.use(
      http.get('/v1/stats', ({ request }) => {
        seen.stats = new URL(request.url).searchParams.get('project')
        return HttpResponse.json(STATS_RESPONSE)
      }),
      http.get('/v1/jobs', ({ request }) => {
        seen.jobs = new URL(request.url).searchParams.get('project')
        return HttpResponse.json(JOBS_RESPONSE)
      }),
      http.get('/v1/groupby', ({ request }) => {
        seen.groupby = new URL(request.url).searchParams.get('project')
        return HttpResponse.json(GROUPBY_RESPONSE)
      }),
    )
    renderOverview('/overview?project=acme')
    await waitFor(() => expect(seen.stats).toBe('acme'))
    await waitFor(() => expect(seen.jobs).toBe('acme'))
    await waitFor(() => expect(seen.groupby).toBe('acme'))
  })
})
