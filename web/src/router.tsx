import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  useRouter,
} from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { RootShell } from '@/routes/__root'
import { ExploreRoute } from '@/routes/explore'
import { parseSearch, stringifySearch } from '@/lib/filters'

// Root error boundary for any throw *inside* a matched route. TanStack renders
// this in the failing route's <Outlet/> slot, so the persistent shell (brand +
// nav, owned by RootShell) stays mounted and only the route body is replaced —
// a far better failure mode than the built-in unbranded "Something went wrong!"
// that, at the root level, would blow away the whole shell. The fallback is
// recoverable: `router.invalidate()` re-runs loaders and `reset()` clears the
// boundary so a transient error can be retried without a full reload.
function RouteErrorFallback({ error, reset }: ErrorComponentProps) {
  const router = useRouter()
  return (
    <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
      <div
        role="alert"
        style={{
          maxWidth: 560,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: '16px 18px',
          background: 'var(--tb-surface)',
          border: '1px solid var(--tb-border)',
          borderInlineStart: '3px solid var(--tb-error)',
          borderRadius: 6,
        }}
      >
        <strong style={{ fontSize: 15 }}>Something went wrong</strong>
        <span style={{ color: 'var(--tb-mut)', fontSize: 14 }}>
          This view hit an unexpected error.
          {error?.message ? ` (${error.message})` : ''}
        </span>
        <div>
          <button
            type="button"
            onClick={() => {
              // Re-run loaders for the failing match, then clear the boundary.
              router.invalidate()
              reset()
            }}
            style={{
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid var(--tb-border)',
              background: 'var(--tb-2)',
              color: 'var(--tb-text)',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Try again
          </button>
        </div>
      </div>
    </div>
  )
}

const rootRoute = createRootRoute({ component: RootShell })

// Explore ("/") is the default log-search view and must paint fast, so it ships in
// the main chunk (eager import above). Stats and Docs are not needed on first paint
// and carry heavy payloads — Stats pulls in recharts (~100 kB gzip), Docs pulls in
// the full in-app docs content — so both are code-split via lazyRouteComponent and
// fetched only when their route is visited, keeping the initial bundle lean.
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: ExploreRoute })
const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/stats',
  component: lazyRouteComponent(() => import('@/routes/stats'), 'StatsRoute'),
})
const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/docs/$page',
  component: lazyRouteComponent(() => import('@/routes/docs.$page'), 'DocsRoute'),
})
const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/overview',
  component: lazyRouteComponent(() => import('@/routes/overview'), 'OverviewRoute'),
})
const jobsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/jobs',
  component: lazyRouteComponent(() => import('@/routes/jobs'), 'JobsRoute'),
})

const routeTree = rootRoute.addChildren([indexRoute, statsRoute, docsRoute, overviewRoute, jobsRoute])

// Treat every search value as an opaque string. TanStack Router's DEFAULT search
// (de)serializer JSON-coerces values, which silently drops a bookmarked `q=null`
// (literal regex "null") and mangles JSON-shaped values into "[object Object]" —
// breaking the "URL is the shareable saved search" contract (spec §3/§7). These
// match what explore.test.tsx wires into its router, so the app and tests share
// the same URL boundary. (filters.ts owns the string-preserving implementations.)
export const router = createRouter({
  routeTree,
  parseSearch,
  stringifySearch,
  // Branded, recoverable, shell-preserving fallback for any route-level throw.
  defaultErrorComponent: RouteErrorFallback,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
