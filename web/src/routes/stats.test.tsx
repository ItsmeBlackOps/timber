// Task F11 — Stats route (contract C-F10 / spec §8.3).
// Full-render tests with MSW: the dashboard hydrates range/app/group from the URL,
// renders MetricCards + every StatChart from /v1/stats, exposes an hour/day toggle
// that rewrites the `group` URL param + refetches, and shows a "top by" strip
// (top services / users / models) sourced from /v1/groupby. Range + app live in the
// URL using the same keys as the Explore filter contract (C-F3) so they are shared
// across the two views.
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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
import type { Settings } from '@/lib/settings'
import type { StatsBucket, StatsResponse } from '@/lib/types'
import { StatsRoute } from '@/routes/stats'

// The data hooks read base URL + read key from settings (C-F5). Mock the module so
// this suite depends only on the C-F5 shape, not F3's localStorage impl, and so the
// queries are enabled (non-empty read key).
const settingsMock = vi.hoisted(() => ({ loadSettings: vi.fn() }))
vi.mock('@/lib/settings', () => settingsMock)

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

function bucket(over: Partial<StatsBucket> = {}): StatsBucket {
  return {
    bucket: '2026-06-14T00:00:00.000Z',
    total: 0,
    counts: { debug: 0, info: 0, warn: 0, error: 0 },
    latency: null,
    errorRate: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...over,
  }
}

const SAMPLE_BUCKETS: StatsBucket[] = [
  bucket({
    bucket: '2026-06-14T00:00:00.000Z',
    total: 100,
    counts: { debug: 5, info: 90, warn: 3, error: 2 },
    latency: { p50: 10, p95: 120, p99: 200 },
    errorRate: 2,
    costUsd: 0.5,
    inputTokens: 1000,
    outputTokens: 400,
  }),
  bucket({
    bucket: '2026-06-14T01:00:00.000Z',
    total: 50,
    counts: { debug: 0, info: 45, warn: 4, error: 1 },
    latency: { p50: 12, p95: 150, p99: 300 },
    errorRate: 2,
    costUsd: 1.25,
    inputTokens: 800,
    outputTokens: 320,
  }),
]

/** Default stats handler: records the last request's search params, returns SAMPLE. */
function mockStats(): { lastParams: () => URLSearchParams | null } {
  let seen: URLSearchParams | null = null
  server.use(
    http.get('/v1/stats', ({ request }) => {
      seen = new URL(request.url).searchParams
      const group = (seen.get('group') as 'hour' | 'day') ?? 'hour'
      return HttpResponse.json({
        group,
        from: seen.get('from') ?? '2026-06-13T00:00:00.000Z',
        to: seen.get('to') ?? '2026-06-14T00:00:00.000Z',
        buckets: SAMPLE_BUCKETS,
      } satisfies StatsResponse)
    }),
  )
  return { lastParams: () => seen }
}

/** Make /v1/stats fail with the given HTTP status (auth/storage banner cases). */
function mockStatsStatus(status: number): void {
  server.use(
    http.get('/v1/stats', () =>
      HttpResponse.json({ error: `status ${status}` }, { status }),
    ),
  )
}

/** Default groupby handler: returns a distinct top-list per `by` dimension. */
function mockGroupBy(): { bySeen: () => string[] } {
  const seen: string[] = []
  server.use(
    http.get('/v1/groupby', ({ request }) => {
      const by = new URL(request.url).searchParams.get('by') ?? ''
      seen.push(by)
      const table: Record<string, { value: string; count: number }[]> = {
        app: [
          { value: 'api', count: 120 },
          { value: 'worker', count: 30 },
        ],
        'ids.userEmail': [
          { value: 'ada@example.com', count: 80 },
          { value: 'lin@example.com', count: 20 },
        ],
        'data.model': [
          { value: 'gpt-4o', count: 70 },
          { value: 'claude-3', count: 25 },
        ],
      }
      const groups = table[by] ?? []
      const total = groups.reduce((s, g) => s + g.count, 0)
      return HttpResponse.json({ by, total, groups, otherCount: 0 })
    }),
  )
  return { bySeen: () => seen }
}

/**
 * Mount the real StatsRoute under a memory router at the given URL. The route
 * reads/writes its own search params, so no validateSearch is declared here
 * (mirrors the F0 router, which has none) — the component uses strict:false.
 */
function renderStats(initial = '/stats') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const statsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/stats',
    component: StatsRoute,
  })
  // an index route so navigation targets resolve; not used by these tests
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div>home</div>,
  })
  const routeTree = rootRoute.addChildren([indexRoute, statsRoute])
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
  return { router, container }
}

beforeEach(() => {
  setSettings()
  vi.restoreAllMocks()
})

describe('StatsRoute', () => {
  it('renders the five metric cards from /v1/stats', async () => {
    mockStats()
    mockGroupBy()
    renderStats()

    // total = 150 across the two sample buckets
    await waitFor(() =>
      expect(screen.getByTestId('metric-total')).toHaveTextContent(/150/),
    )
    for (const id of ['total', 'errorRate', 'cost', 'p95', 'tokens']) {
      expect(screen.getByTestId(`metric-${id}`)).toBeInTheDocument()
    }
  })

  it('renders every stat chart kind (volume/errorRate/cost/tokens/latency)', async () => {
    mockStats()
    mockGroupBy()
    const { container } = renderStats()

    await waitFor(() => expect(screen.getByTestId('metric-total')).toBeInTheDocument())

    const kinds = ['volume', 'errorRate', 'cost', 'tokens', 'latency']
    for (const kind of kinds) {
      expect(container.querySelector(`figure[data-kind="${kind}"]`)).toBeTruthy()
    }
  })

  it('hour/day toggle rewrites the group URL param and refetches with group=day', async () => {
    const stats = mockStats()
    mockGroupBy()
    const { router } = renderStats('/stats')
    const user = userEvent.setup()

    // first load defaults to hour
    await waitFor(() => expect(stats.lastParams()?.get('group')).toBe('hour'))

    await user.click(screen.getByRole('button', { name: /^day$/i }))

    await waitFor(() => expect(stats.lastParams()?.get('group')).toBe('day'))
    expect(router.state.location.search).toMatchObject({ group: 'day' })
  })

  it('shares range + app with Explore via the URL (app + window passed to /v1/stats)', async () => {
    const stats = mockStats()
    mockGroupBy()
    renderStats(
      '/stats?app=api&from=2026-06-10T00:00:00.000Z&to=2026-06-11T00:00:00.000Z',
    )

    await waitFor(() => expect(stats.lastParams()).not.toBeNull())
    const p = stats.lastParams() as URLSearchParams
    expect(p.get('app')).toBe('api')
    expect(p.get('from')).toBe('2026-06-10T00:00:00.000Z')
    expect(p.get('to')).toBe('2026-06-11T00:00:00.000Z')
  })

  it('range preset selection writes from/to to the URL (shared key) and refetches', async () => {
    const stats = mockStats()
    mockGroupBy()
    const { router } = renderStats('/stats')
    const user = userEvent.setup()

    await waitFor(() => expect(stats.lastParams()).not.toBeNull())

    // pick the 1-hour preset; the route should write a from/to window to the URL
    await user.click(screen.getByRole('button', { name: /last hour/i }))

    await waitFor(() => {
      const search = router.state.location.search as Record<string, unknown>
      expect(typeof search.from).toBe('string')
      expect(typeof search.to).toBe('string')
    })
    // and the stats query picked up the new window (from/to present)
    await waitFor(() => {
      const p = stats.lastParams() as URLSearchParams
      expect(p.has('from')).toBe(true)
      expect(p.has('to')).toBe(true)
    })
  })

  it('renders a "top by" strip with top services, users and models from /v1/groupby', async () => {
    mockStats()
    const gb = mockGroupBy()
    renderStats()

    // the strip queries the three dimensions
    await waitFor(() => {
      const seen = gb.bySeen()
      expect(seen).toContain('app')
      expect(seen).toContain('ids.userEmail')
      expect(seen).toContain('data.model')
    })

    const strip = await screen.findByTestId('top-by-strip')
    // top service, user, model values render somewhere in the strip
    expect(within(strip).getByText('api')).toBeInTheDocument()
    expect(within(strip).getByText('ada@example.com')).toBeInTheDocument()
    expect(within(strip).getByText('gpt-4o')).toBeInTheDocument()
  })

  it('passes the user-identity key from settings to the top-users breakdown', async () => {
    setSettings({ userKeys: ['accountId', 'userId'] })
    mockStats()
    const gb = mockGroupBy()
    renderStats()

    await waitFor(() => expect(gb.bySeen()).toContain('ids.accountId'))
  })

  it('shows the 401 re-auth Banner when the stats query is unauthorized', async () => {
    mockStatsStatus(401)
    mockGroupBy()
    renderStats()

    // The re-auth Banner copy (C-F9) — not the generic "Could not load stats".
    expect(await screen.findByText(/unauthorized|read key/i)).toBeInTheDocument()
    const banner = screen.getByRole('alert')
    expect(banner).toHaveAttribute('data-kind', '401')
    expect(screen.queryByText(/could not load stats/i)).not.toBeInTheDocument()
  })

  it('shows the 503 storage-unavailable Banner when the stats store is down', async () => {
    mockStatsStatus(503)
    mockGroupBy()
    renderStats()

    expect(await screen.findByText(/storage unavailable/i)).toBeInTheDocument()
    const banner = screen.getByRole('alert')
    expect(banner).toHaveAttribute('data-kind', '503')
    expect(screen.queryByText(/could not load stats/i)).not.toBeInTheDocument()
  })

  it('falls back to the generic error alert for a non-401/503 stats failure', async () => {
    mockStatsStatus(500)
    mockGroupBy()
    renderStats()

    expect(await screen.findByText(/could not load stats/i)).toBeInTheDocument()
  })

  it('a failed top-by column shows an error state, not a misleading "No data"', async () => {
    mockStats()
    // groupby fails for every dimension — the columns must not claim "No data"
    // (which means "queried fine, nothing matched"); they should signal failure.
    server.use(
      http.get('/v1/groupby', () =>
        HttpResponse.json({ error: 'boom' }, { status: 503 }),
      ),
    )
    renderStats()

    const col = await screen.findByTestId('top-by-app')
    await waitFor(() => expect(within(col).queryByText(/loading/i)).not.toBeInTheDocument())
    expect(within(col).queryByText(/^no data$/i)).not.toBeInTheDocument()
    expect(within(col).getByText(/unavailable|failed|couldn’t|couldn't|error/i)).toBeInTheDocument()
  })
})
