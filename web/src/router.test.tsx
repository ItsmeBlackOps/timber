// Router code-splitting contract.
//
// The default route ("/", Explore) is the primary log-search view and must paint
// fast, so it is imported eagerly. The Stats route pulls in recharts (~100 kB gzip)
// and the Docs route pulls in the full in-app docs content; neither is needed on
// first paint, so both MUST be code-split via TanStack Router's `lazyRouteComponent`
// so they land in their own chunks fetched only when visited. Without splitting,
// `vite build` emits a single ~235 kB-gzip chunk and recharts loads on "/".
//
// We assert the split structurally on the route tree (a `lazyRouteComponent` result
// is a function carrying a `.preload` method and is NOT the eagerly-imported route
// component), plus a functional check that the lazy Stats route still resolves and
// renders end-to-end under a memory router.
import { render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { router } from './router'
import { RootShell } from '@/routes/__root'
import { ExploreRoute } from '@/routes/explore'
import { StatsRoute } from '@/routes/stats'
import { DocsRoute } from '@/routes/docs.$page'

// Stats/Docs read base URL + read key from settings (C-F5); mock so their queries
// are enabled and this suite stays independent of the localStorage impl. Only
// `loadSettings` is overridden — the rest of the module (DEFAULTS, saveSettings)
// is kept via importOriginal, because the real route tree mounts the full shell
// (SettingsDialog/ThemeToggle) which imports those named exports; a bare
// `{ loadSettings }` mock makes them throw "No <export> is defined on the mock".
const settingsMock = vi.hoisted(() => ({ loadSettings: vi.fn() }))
vi.mock('@/lib/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settings')>()
  return { ...actual, loadSettings: settingsMock.loadSettings }
})

const BASE_SETTINGS = {
  apiBaseUrl: '',
  readKey: 'tb_read',
  theme: 'system' as const,
  tailIntervalMs: 2000,
  userKeys: ['userEmail', 'userId'],
  slowMs: 300,
}

beforeEach(() => {
  settingsMock.loadSettings.mockReturnValue(BASE_SETTINGS)
})

type AnyRoute = {
  options: { path?: string; component?: unknown }
}

function routeByPath(path: string): AnyRoute {
  const children = (router.routeTree.children ?? []) as AnyRoute[]
  const match = children.find((r) => r.options.path === path)
  if (!match) throw new Error(`no route registered for path ${path}`)
  return match
}

/** A `lazyRouteComponent` result is a function with a `.preload` method. */
function isLazyComponent(component: unknown): boolean {
  return (
    typeof component === 'function' &&
    typeof (component as { preload?: unknown }).preload === 'function'
  )
}

describe('router code-splitting', () => {
  it('keeps the Explore ("/") route eager for a fast first paint', () => {
    const indexRoute = routeByPath('/')
    // Eager: the route component is the statically imported function itself,
    // not a lazy wrapper.
    expect(indexRoute.options.component).toBe(ExploreRoute)
    expect(isLazyComponent(indexRoute.options.component)).toBe(false)
  })

  it('code-splits the Stats route (recharts) via lazyRouteComponent', () => {
    const statsRoute = routeByPath('/stats')
    // Must be a lazy component (own chunk), never the eagerly-imported StatsRoute.
    expect(statsRoute.options.component).not.toBe(StatsRoute)
    expect(isLazyComponent(statsRoute.options.component)).toBe(true)
  })

  it('code-splits the Docs route (docs content) via lazyRouteComponent', () => {
    const docsRoute = routeByPath('/docs/$page')
    expect(docsRoute.options.component).not.toBe(DocsRoute)
    expect(isLazyComponent(docsRoute.options.component)).toBe(true)
  })

  it('still resolves and renders the lazy Stats route end-to-end', async () => {
    // Reuse the real route tree (with its lazy wiring) under a memory history so
    // the lazy component is actually fetched + rendered, proving the split works.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    })
    const memRouter = createRouter({
      routeTree: router.routeTree,
      history: createMemoryHistory({ initialEntries: ['/stats'] }),
    })
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={memRouter} />
      </QueryClientProvider>,
    )
    // The Stats dashboard renders its metric cards once the lazy chunk resolves.
    await waitFor(() =>
      expect(screen.getByTestId('metric-total')).toBeInTheDocument(),
    )
  })
})

// Root error-boundary contract.
//
// Finding (web-react-quality): with no `errorComponent`/`defaultErrorComponent`,
// a render throw in a deep component falls through to TanStack's built-in
// "Something went wrong!" UI — which is unbranded, non-recoverable, AND (for a
// leaf throw) loses the persistent shell/nav, because the built-in component
// replaces the whole match subtree at the root level. We configure a root
// `defaultErrorComponent` on createRouter so that:
//   1. the fallback is branded ("Timber") and recoverable (offers retry), and
//   2. for a *route-level* throw, the persistent shell (brand + Primary nav)
//      still renders, with only the failing route's content swapped for the
//      fallback inside the <Outlet/>.
describe('router error handling', () => {
  let errSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    // React logs caught render errors to console.error; the throw is intentional.
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errSpy.mockRestore()
  })

  it('configures a defaultErrorComponent on the router', () => {
    expect(router.options.defaultErrorComponent).toBeTruthy()
  })

  it('renders a branded, recoverable fallback (and keeps the shell) when a route throws', async () => {
    // Build a tree using the REAL RootShell (so the chrome is the real nav) and
    // the REAL configured defaultErrorComponent, with a leaf route that throws on
    // render. This proves the configured boundary catches the throw, renders a
    // branded recoverable fallback, and leaves the persistent shell intact.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
    })
    const rootRoute = createRootRoute({ component: RootShell })
    const boomRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => {
        throw new Error('route render exploded')
      },
    })
    const errRouter = createRouter({
      routeTree: rootRoute.addChildren([boomRoute]),
      history: createMemoryHistory({ initialEntries: ['/'] }),
      defaultErrorComponent: router.options.defaultErrorComponent,
    })
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={errRouter} />
      </QueryClientProvider>,
    )

    // Branded, recoverable fallback rendered inside the outlet.
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/something went wrong|unexpected error|error/i)
    expect(
      screen.getByRole('button', { name: /try again|retry|reload/i }),
    ).toBeInTheDocument()

    // The built-in unbranded fallback must NOT be what's showing.
    expect(screen.queryByText(/^Something went wrong!$/)).not.toBeInTheDocument()

    // Persistent shell survives: brand + Primary nav are still present.
    expect(screen.getByText('Timber')).toBeInTheDocument()
    expect(
      screen.getByRole('navigation', { name: /primary/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /explore/i })).toBeInTheDocument()
  })
})
