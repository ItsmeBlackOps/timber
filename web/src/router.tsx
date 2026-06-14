import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { RootShell } from '@/routes/__root'
import { ExploreRoute } from '@/routes/explore'
import { StatsRoute } from '@/routes/stats'
import { DocsRoute } from '@/routes/docs.$page'

const rootRoute = createRootRoute({ component: RootShell })

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: ExploreRoute })
const statsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/stats', component: StatsRoute })
const docsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/docs/$page', component: DocsRoute })

const routeTree = rootRoute.addChildren([indexRoute, statsRoute, docsRoute])

export const router = createRouter({ routeTree })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
