// Tests for the data hooks (contract C-F8). MSW mocks the network; a fresh
// QueryClient per test (retry off, no gc) keeps cases isolated and lets an
// ApiError surface immediately as a query error instead of being retried.
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor, act } from '@testing-library/react'

import { server } from '../../test/msw-server'
import type { Settings } from '@/lib/settings'
import type { Filters } from '@/lib/filters'
import { ALL_LEVELS } from '@/lib/filters'
import type { LogsResponse } from '@/lib/types'

// The hooks read base URL + read key from settings (C-F5). Mock the module so
// these suites don't depend on F3's localStorage impl — only the C-F5 shape.
const settingsMock = vi.hoisted(() => ({ loadSettings: vi.fn() }))
vi.mock('@/lib/settings', () => settingsMock)

import {
  useLogs,
  useLiveTail,
  useStats,
  useEvents,
  useFacets,
  useGroupBy,
  useHealth,
} from '@/hooks'

const BASE_SETTINGS: Settings = {
  apiBaseUrl: '',
  readKey: 'tb_read', // most tests want the hooks enabled
  theme: 'system',
  tailIntervalMs: 2000,
  userKeys: ['userEmail', 'userId'],
  slowMs: 300,
}

function setSettings(partial: Partial<Settings>): void {
  settingsMock.loadSettings.mockReturnValue({ ...BASE_SETTINGS, ...partial })
}

/** A QueryClientProvider wrapper backed by a throwaway client (no retries). */
function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
    },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
  return { Wrapper, queryClient }
}

const emptyFilters: Filters = { levels: [], ids: [], data: [] }
const range = { from: '2026-06-13T00:00:00.000Z', to: '2026-06-14T00:00:00.000Z' }

function logDoc(id: string): LogsResponse['items'][number] {
  return {
    _id: id,
    app: 'api',
    env: 'prod',
    event: 'http.request',
    level: 'info',
    receivedAt: '2026-06-14T00:00:00.000Z',
    expiresAt: '2026-07-14T00:00:00.000Z',
  }
}

beforeEach(() => {
  setSettings({})
  vi.restoreAllMocks()
})

describe('useLogs (infinite)', () => {
  it('merges pages into a flat items array and stops at nextCursor===null', async () => {
    const pages: Record<string, LogsResponse> = {
      '': { items: [logDoc('a'), logDoc('b')], nextCursor: 'cur2' },
      cur2: { items: [logDoc('c')], nextCursor: null },
    }
    server.use(
      http.get('/v1/logs', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor') ?? ''
        return HttpResponse.json(pages[cursor])
      }),
    )
    const { Wrapper } = makeWrapper()

    const { result } = renderHook(() => useLogs(emptyFilters), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.items).toHaveLength(2))
    expect(result.current.hasNextPage).toBe(true)

    await act(async () => {
      await result.current.fetchNextPage()
    })

    await waitFor(() => expect(result.current.items).toHaveLength(3))
    expect(result.current.items.map((d) => d._id)).toEqual(['a', 'b', 'c'])
    expect(result.current.hasNextPage).toBe(false)
  })

  it('sends the filter params and never sends cursor on page 1', async () => {
    let seen: URLSearchParams | null = null
    server.use(
      http.get('/v1/logs', ({ request }) => {
        seen = new URL(request.url).searchParams
        return HttpResponse.json({ items: [], nextCursor: null } satisfies LogsResponse)
      }),
    )
    const { Wrapper } = makeWrapper()
    const filters: Filters = {
      levels: ['error', 'warn'],
      ids: [{ key: 'userEmail', value: 'a@b.co' }],
      data: [],
      app: 'api',
    }

    renderHook(() => useLogs(filters), { wrapper: Wrapper })

    await waitFor(() => expect(seen).not.toBeNull())
    const p = seen as unknown as URLSearchParams
    expect(p.get('app')).toBe('api')
    expect(p.get('level')).toBe('error,warn')
    expect(p.get('ids.userEmail')).toBe('a@b.co')
    expect(p.has('cursor')).toBe(false)
  })

  it('is disabled (no fetch) when readKey is empty', async () => {
    setSettings({ readKey: '' })
    let hit = false
    server.use(
      http.get('/v1/logs', () => {
        hit = true
        return HttpResponse.json({ items: [], nextCursor: null } satisfies LogsResponse)
      }),
    )
    const { Wrapper } = makeWrapper()

    const { result } = renderHook(() => useLogs(emptyFilters), { wrapper: Wrapper })

    // give react-query a tick; nothing should fire
    await new Promise((r) => setTimeout(r, 30))
    expect(hit).toBe(false)
    expect(result.current.items).toEqual([])
  })

  it('surfaces an ApiError(401) as a query error', async () => {
    server.use(
      http.get('/v1/logs', () => HttpResponse.json({ error: 'unauthorized' }, { status: 401 })),
    )
    const { Wrapper } = makeWrapper()

    const { result } = renderHook(() => useLogs(emptyFilters), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect((result.current.error as { status?: number })?.status).toBe(401)
  })
})

describe('useLiveTail', () => {
  it('does not fetch when enabled is false', async () => {
    let hit = false
    server.use(
      http.get('/v1/logs', () => {
        hit = true
        return HttpResponse.json({ items: [logDoc('a')], nextCursor: null } satisfies LogsResponse)
      }),
    )
    const { Wrapper } = makeWrapper()

    renderHook(() => useLiveTail(emptyFilters, false), { wrapper: Wrapper })

    await new Promise((r) => setTimeout(r, 30))
    expect(hit).toBe(false)
  })

  it('does not fetch when the document is hidden, even if enabled', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    let hit = false
    server.use(
      http.get('/v1/logs', () => {
        hit = true
        return HttpResponse.json({ items: [logDoc('a')], nextCursor: null } satisfies LogsResponse)
      }),
    )
    const { Wrapper } = makeWrapper()

    renderHook(() => useLiveTail(emptyFilters, true), { wrapper: Wrapper })

    await new Promise((r) => setTimeout(r, 30))
    expect(hit).toBe(false)
  })

  it('fetches page-1 (no cursor) when enabled and visible, returning items', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let sawCursor = true
    server.use(
      http.get('/v1/logs', ({ request }) => {
        sawCursor = new URL(request.url).searchParams.has('cursor')
        return HttpResponse.json({
          items: [logDoc('x'), logDoc('y')],
          nextCursor: 'c',
        } satisfies LogsResponse)
      }),
    )
    const { Wrapper } = makeWrapper()

    const { result } = renderHook(() => useLiveTail(emptyFilters, true), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.items).toHaveLength(2))
    expect(sawCursor).toBe(false)
    expect(result.current.items.map((d) => d._id)).toEqual(['x', 'y'])
  })

  it('is disabled when readKey is empty', async () => {
    setSettings({ readKey: '' })
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    let hit = false
    server.use(
      http.get('/v1/logs', () => {
        hit = true
        return HttpResponse.json({ items: [], nextCursor: null } satisfies LogsResponse)
      }),
    )
    const { Wrapper } = makeWrapper()

    renderHook(() => useLiveTail(emptyFilters, true), { wrapper: Wrapper })

    await new Promise((r) => setTimeout(r, 30))
    expect(hit).toBe(false)
  })
})

describe('useStats', () => {
  it('passes group/from/to/app/event params and returns parsed data', async () => {
    let seen: URLSearchParams | null = null
    server.use(
      http.get('/v1/stats', ({ request }) => {
        seen = new URL(request.url).searchParams
        return HttpResponse.json({ group: 'hour', from: range.from, to: range.to, buckets: [] })
      }),
    )
    const { Wrapper } = makeWrapper()

    const { result } = renderHook(
      () => useStats(range, 'hour', 'api', 'ai.'),
      { wrapper: Wrapper },
    )

    await waitFor(() => expect(result.current.data).toBeDefined())
    const p = seen as unknown as URLSearchParams
    expect(p.get('group')).toBe('hour')
    expect(p.get('from')).toBe(range.from)
    expect(p.get('to')).toBe(range.to)
    expect(p.get('app')).toBe('api')
    expect(p.get('event')).toBe('ai.')
    expect(result.current.data?.group).toBe('hour')
  })

  it('omits app/event when not provided', async () => {
    let seen: URLSearchParams | null = null
    server.use(
      http.get('/v1/stats', ({ request }) => {
        seen = new URL(request.url).searchParams
        return HttpResponse.json({ group: 'day', from: range.from, to: range.to, buckets: [] })
      }),
    )
    const { Wrapper } = makeWrapper()

    renderHook(() => useStats(range, 'day'), { wrapper: Wrapper })

    await waitFor(() => expect(seen).not.toBeNull())
    const p = seen as unknown as URLSearchParams
    expect(p.has('app')).toBe(false)
    expect(p.has('event')).toBe(false)
    expect(p.get('group')).toBe('day')
  })

  it('is disabled when readKey is empty', async () => {
    setSettings({ readKey: '' })
    let hit = false
    server.use(
      http.get('/v1/stats', () => {
        hit = true
        return HttpResponse.json({ group: 'hour', from: range.from, to: range.to, buckets: [] })
      }),
    )
    const { Wrapper } = makeWrapper()

    renderHook(() => useStats(range, 'hour'), { wrapper: Wrapper })

    await new Promise((r) => setTimeout(r, 30))
    expect(hit).toBe(false)
  })
})

describe('useEvents', () => {
  it('fetches /v1/events and returns the apps map', async () => {
    server.use(
      http.get('/v1/events', () => HttpResponse.json({ apps: { api: ['http.', 'ai.'] } })),
    )
    const { Wrapper } = makeWrapper()

    const { result } = renderHook(() => useEvents(), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data?.apps.api).toEqual(['http.', 'ai.'])
  })

  it('is disabled when readKey is empty', async () => {
    setSettings({ readKey: '' })
    let hit = false
    server.use(
      http.get('/v1/events', () => {
        hit = true
        return HttpResponse.json({ apps: {} })
      }),
    )
    const { Wrapper } = makeWrapper()

    renderHook(() => useEvents(), { wrapper: Wrapper })

    await new Promise((r) => setTimeout(r, 30))
    expect(hit).toBe(false)
  })
})

describe('useFacets', () => {
  it('passes app + from/to and returns discovered keys', async () => {
    let seen: URLSearchParams | null = null
    server.use(
      http.get('/v1/facets', ({ request }) => {
        seen = new URL(request.url).searchParams
        return HttpResponse.json({ window: range, idsKeys: ['userEmail'], dataPaths: ['latencyMs'] })
      }),
    )
    const { Wrapper } = makeWrapper()

    const { result } = renderHook(() => useFacets('api', range), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.data).toBeDefined())
    const p = seen as unknown as URLSearchParams
    expect(p.get('app')).toBe('api')
    expect(p.get('from')).toBe(range.from)
    expect(p.get('to')).toBe(range.to)
    expect(result.current.data?.idsKeys).toEqual(['userEmail'])
  })

  it('omits app when not provided', async () => {
    let seen: URLSearchParams | null = null
    server.use(
      http.get('/v1/facets', ({ request }) => {
        seen = new URL(request.url).searchParams
        return HttpResponse.json({ window: range, idsKeys: [], dataPaths: [] })
      }),
    )
    const { Wrapper } = makeWrapper()

    renderHook(() => useFacets(undefined, range), { wrapper: Wrapper })

    await waitFor(() => expect(seen).not.toBeNull())
    expect((seen as unknown as URLSearchParams).has('app')).toBe(false)
  })

  it('is disabled when readKey is empty', async () => {
    setSettings({ readKey: '' })
    let hit = false
    server.use(
      http.get('/v1/facets', () => {
        hit = true
        return HttpResponse.json({ window: range, idsKeys: [], dataPaths: [] })
      }),
    )
    const { Wrapper } = makeWrapper()

    renderHook(() => useFacets('api', range), { wrapper: Wrapper })

    await new Promise((r) => setTimeout(r, 30))
    expect(hit).toBe(false)
  })
})

describe('useGroupBy', () => {
  it('sends by + filter params + limit + like and returns groups', async () => {
    let seen: URLSearchParams | null = null
    server.use(
      http.get('/v1/groupby', ({ request }) => {
        seen = new URL(request.url).searchParams
        return HttpResponse.json({
          by: 'ids.userEmail',
          total: 3,
          groups: [{ value: 'a@b.co', count: 3 }],
          otherCount: 0,
        })
      }),
    )
    const { Wrapper } = makeWrapper()
    const filters: Filters = { levels: ['error'], ids: [], data: [] }

    const { result } = renderHook(
      () => useGroupBy('ids.userEmail', filters, { limit: 10, like: 'a' }),
      { wrapper: Wrapper },
    )

    await waitFor(() => expect(result.current.data).toBeDefined())
    const p = seen as unknown as URLSearchParams
    expect(p.get('by')).toBe('ids.userEmail')
    expect(p.get('level')).toBe('error')
    expect(p.get('limit')).toBe('10')
    expect(p.get('like')).toBe('a')
    expect(p.has('cursor')).toBe(false)
    expect(result.current.data?.groups[0].value).toBe('a@b.co')
  })

  it('respects the enabled flag from options (no fetch when false)', async () => {
    let hit = false
    server.use(
      http.get('/v1/groupby', () => {
        hit = true
        return HttpResponse.json({ by: 'app', total: 0, groups: [], otherCount: 0 })
      }),
    )
    const { Wrapper } = makeWrapper()

    renderHook(() => useGroupBy('app', emptyFilters, { enabled: false }), { wrapper: Wrapper })

    await new Promise((r) => setTimeout(r, 30))
    expect(hit).toBe(false)
  })

  it('is disabled when readKey is empty', async () => {
    setSettings({ readKey: '' })
    let hit = false
    server.use(
      http.get('/v1/groupby', () => {
        hit = true
        return HttpResponse.json({ by: 'app', total: 0, groups: [], otherCount: 0 })
      }),
    )
    const { Wrapper } = makeWrapper()

    renderHook(() => useGroupBy('app', emptyFilters), { wrapper: Wrapper })

    await new Promise((r) => setTimeout(r, 30))
    expect(hit).toBe(false)
  })

  it('surfaces an ApiError(400) as a query error (bad by field)', async () => {
    server.use(
      http.get('/v1/groupby', () => HttpResponse.json({ error: 'invalid by field' }, { status: 400 })),
    )
    const { Wrapper } = makeWrapper()

    const { result } = renderHook(() => useGroupBy('app', emptyFilters), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect((result.current.error as { status?: number })?.status).toBe(400)
  })
})

describe('useHealth', () => {
  it('fetches /healthz and returns parsed health', async () => {
    server.use(
      http.get('/healthz', () =>
        HttpResponse.json({
          ok: true,
          wal: { totalBytes: 0, backlogBytes: 0, overBudget: false },
          flusher: { running: true, caughtUp: true, flushedTotal: 0, lastError: null },
          mongo: { connected: true },
        }),
      ),
    )
    const { Wrapper } = makeWrapper()

    const { result } = renderHook(() => useHealth(), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data?.ok).toBe(true)
    expect(result.current.data?.mongo.connected).toBe(true)
  })

  it('still fetches health when readKey is empty (health is not gated on a key)', async () => {
    setSettings({ readKey: '' })
    let hit = false
    server.use(
      http.get('/healthz', () => {
        hit = true
        return HttpResponse.json({
          ok: true,
          wal: { totalBytes: 0, backlogBytes: 0, overBudget: false },
          flusher: { running: true, caughtUp: true, flushedTotal: 0, lastError: null },
          mongo: { connected: true },
        })
      }),
    )
    const { Wrapper } = makeWrapper()

    renderHook(() => useHealth(), { wrapper: Wrapper })

    await waitFor(() => expect(hit).toBe(true))
  })
})

// Keep ALL_LEVELS import used (guards against an unused-import error if a test
// above is edited away) and documents the all-levels => no `level` param rule.
describe('filters serialization sanity', () => {
  it('all four levels selected emits no level param via useLogs', async () => {
    let seen: URLSearchParams | null = null
    server.use(
      http.get('/v1/logs', ({ request }) => {
        seen = new URL(request.url).searchParams
        return HttpResponse.json({ items: [], nextCursor: null } satisfies LogsResponse)
      }),
    )
    const { Wrapper } = makeWrapper()

    renderHook(() => useLogs({ levels: [...ALL_LEVELS], ids: [], data: [] }), { wrapper: Wrapper })

    await waitFor(() => expect(seen).not.toBeNull())
    expect((seen as unknown as URLSearchParams).has('level')).toBe(false)
  })
})
