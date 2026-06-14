// Shared MSW handler set for the Timber Console (Task F13).
//
// `defaultHandlers` is the baseline network description for the whole frontend
// test suite: it answers every query endpoint (`/v1/logs`, `/v1/stats`,
// `/v1/events`, `/v1/facets`, `/v1/groupby`, `/healthz`) with the PRD §5.2-style
// fixtures from ./fixtures.ts. It is passed to `setupServer(...)` in
// ./msw-server.ts, so it is what `server.resetHandlers()` reverts to after every
// test — meaning any route/component that mounts discovery-driven children
// (AppSwitcher, FindByBar, GroupByPanel, HealthDot, …) gets sane data with zero
// per-test boilerplate. Individual tests still override any single endpoint with
// `server.use(http.get(...))`; the helpers below cover the common overrides.
import { http, HttpResponse } from 'msw'
import type { HttpHandler } from 'msw'

import type { LogsResponse } from '@/lib/types'
import {
  EVENTS_RESPONSE,
  FACETS_RESPONSE,
  GROUPBY_RESPONSE,
  HEALTH_RESPONSE,
  LOGS_RESPONSE,
  STATS_RESPONSE,
} from './fixtures'

/**
 * Default logs handler: returns the full sample page on the first (cursorless)
 * request and an empty, exhausted page for any cursor — so an infinite-query
 * walk terminates instead of looping on the same fixture.
 */
const logsHandler = http.get('/v1/logs', ({ request }) => {
  const cursor = new URL(request.url).searchParams.get('cursor')
  if (cursor) {
    return HttpResponse.json({ items: [], nextCursor: null } satisfies LogsResponse)
  }
  return HttpResponse.json(LOGS_RESPONSE)
})

/** The baseline handler set passed to setupServer(); reverted-to on resetHandlers(). */
export const defaultHandlers: HttpHandler[] = [
  logsHandler,
  http.get('/v1/stats', () => HttpResponse.json(STATS_RESPONSE)),
  http.get('/v1/events', () => HttpResponse.json(EVENTS_RESPONSE)),
  http.get('/v1/facets', () => HttpResponse.json(FACETS_RESPONSE)),
  http.get('/v1/groupby', () => HttpResponse.json(GROUPBY_RESPONSE)),
  http.get('/healthz', () => HttpResponse.json(HEALTH_RESPONSE)),
]

// ---------------------------------------------------------------------------
// Per-case override helpers (pass to server.use(...)).
// ---------------------------------------------------------------------------

/** Serve explicit cursor→page bodies for a multi-page infinite-scroll walk. */
export function logsPages(pages: Record<string, LogsResponse>): HttpHandler {
  return http.get('/v1/logs', ({ request }) => {
    const cursor = new URL(request.url).searchParams.get('cursor') ?? ''
    return HttpResponse.json(pages[cursor] ?? { items: [], nextCursor: null })
  })
}

/** Make any endpoint reply with an error status + `{error}` body (401/503/400/…). */
export function errorOn(path: string, status: number, error = 'error'): HttpHandler {
  return http.get(path, () => HttpResponse.json({ error }, { status }))
}
