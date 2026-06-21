// Task 7 — Jobs dashboard (/jobs).
//
// Full-render tests with MSW: the route renders one row per job (with a TEXT
// status, not color-only), scopes /v1/jobs to the project slug, and links each
// job name into Explore filtered to that job's event. The harness mirrors
// stats.test.tsx — a memory router mounting the real JobsRoute plus an index
// route so the drill-in <Link> resolves, a QueryClient, and a settings mock with
// a non-empty read key so the data hook is enabled.
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor } from '@testing-library/react'
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
import { JOBS_RESPONSE } from '../../test/fixtures'
import type { Settings } from '@/lib/settings'
import { JobsRoute } from '@/routes/jobs'

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

/** Mount the real JobsRoute under a memory router at the given URL. */
function renderJobs(initial = '/jobs') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const jobsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/jobs',
    component: JobsRoute,
  })
  // an index route so the job-name drill-in <Link to="/"> resolves.
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <div>home</div>,
  })
  const routeTree = rootRoute.addChildren([indexRoute, jobsRoute])
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

describe('JobsRoute', () => {
  test('renders a row per job with a text status', async () => {
    renderJobs('/jobs?project=acme')
    expect(await screen.findByText('cron.report')).toBeInTheDocument()
    expect(screen.getByText('cron.sync')).toBeInTheDocument()
    expect(screen.getAllByText(/failed/i).length).toBeGreaterThanOrEqual(1)
  })

  test('passes the project to /v1/jobs', async () => {
    let seen: string | null = null
    server.use(
      http.get('/v1/jobs', ({ request }) => {
        seen = new URL(request.url).searchParams.get('project')
        return HttpResponse.json(JOBS_RESPONSE)
      }),
    )
    renderJobs('/jobs?project=acme')
    await waitFor(() => expect(seen).toBe('acme'))
  })

  test('clicking a job links to Explore filtered to its event', async () => {
    const { router } = renderJobs('/jobs?project=acme')
    await userEvent.click(await screen.findByRole('link', { name: 'cron.report' }))
    await waitFor(() => expect(router.state.location.searchStr).toContain('event=cron.report'))
  })
})
