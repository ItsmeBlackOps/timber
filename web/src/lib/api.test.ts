import { http, HttpResponse } from 'msw'
import { server } from '../../test/msw-server'
import type { Settings } from '@/lib/settings'
import { ApiError } from '@/lib/types'
import type { LogsResponse } from '@/lib/types'

// api.ts reads base URL + read key from the settings module (C-F5, owned by F3).
// Mock it here so this suite is self-contained and doesn't depend on F3's impl —
// we only rely on the C-F5 contract shape (apiBaseUrl, readKey, ...).
const settingsMock = vi.hoisted(() => ({
  loadSettings: vi.fn(),
}))
vi.mock('@/lib/settings', () => settingsMock)

import { apiGet, getLogs, getStats, getEvents, getFacets, getGroupBy, getHealth } from '@/lib/api'

const BASE_SETTINGS: Settings = {
  apiBaseUrl: '',
  readKey: '',
  theme: 'system',
  tailIntervalMs: 2000,
  userKeys: ['userEmail', 'userId'],
  slowMs: 300,
}

function setSettings(partial: Partial<Settings>): void {
  settingsMock.loadSettings.mockReturnValue({ ...BASE_SETTINGS, ...partial })
}

beforeEach(() => {
  setSettings({})
})

describe('apiGet', () => {
  it('sends Authorization: Bearer <key> from settings', async () => {
    setSettings({ readKey: 'tb_read_secret' })
    let seenAuth: string | null = 'UNSET'
    server.use(
      http.get('/v1/logs', ({ request }) => {
        seenAuth = request.headers.get('authorization')
        return HttpResponse.json({ items: [], nextCursor: null } satisfies LogsResponse)
      }),
    )

    await getLogs(new URLSearchParams())

    expect(seenAuth).toBe('Bearer tb_read_secret')
  })

  it('returns the parsed JSON body typed as <T>', async () => {
    const payload: LogsResponse = {
      items: [
        {
          _id: 'a1',
          app: 'api',
          env: 'prod',
          event: 'http.request',
          level: 'info',
          receivedAt: '2026-06-14T00:00:00.000Z',
          expiresAt: '2026-07-14T00:00:00.000Z',
        },
      ],
      nextCursor: 'cur_2',
    }
    server.use(http.get('/v1/logs', () => HttpResponse.json(payload)))

    const res = await getLogs(new URLSearchParams())

    expect(res).toEqual(payload)
    expect(res.items[0]._id).toBe('a1')
    expect(res.nextCursor).toBe('cur_2')
  })

  it('throws ApiError with status===401 on an unauthorized response', async () => {
    server.use(
      http.get('/v1/logs', () => HttpResponse.json({ error: 'unauthorized' }, { status: 401 })),
    )

    const err = await getLogs(new URLSearchParams()).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(401)
    expect((err as ApiError).body).toEqual({ error: 'unauthorized' })
  })

  it('throws ApiError with status===503 on storage-unavailable', async () => {
    server.use(
      http.get('/v1/stats', () => HttpResponse.json({ error: 'storage unavailable' }, { status: 503 })),
    )

    const err = await getStats(new URLSearchParams()).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(503)
  })

  it('carries a non-JSON error body through as text', async () => {
    server.use(
      http.get('/v1/logs', () => new HttpResponse('boom', { status: 500, headers: { 'content-type': 'text/plain' } })),
    )

    const err = await getLogs(new URLSearchParams()).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(500)
    expect((err as ApiError).body).toBe('boom')
  })

  it('prefixes the request with settings.apiBaseUrl when set', async () => {
    setSettings({ apiBaseUrl: 'https://logs.example.com', readKey: 'k' })
    let hit = false
    server.use(
      http.get('https://logs.example.com/v1/logs', () => {
        hit = true
        return HttpResponse.json({ items: [], nextCursor: null } satisfies LogsResponse)
      }),
    )

    await getLogs(new URLSearchParams())

    expect(hit).toBe(true)
  })

  // SECURITY (key-exfiltration / SSRF-to-wrong-origin): apiBaseUrl is operator-
  // settable free text with no host validation. The high-value read key must
  // never be transmitted off-origin, no matter how apiBaseUrl was populated
  // (Settings UI today; a future URL param / imported view / postMessage). The
  // Authorization header is gated to the resolved request origin === location's.
  it('does NOT send the Authorization header when apiBaseUrl is a cross-origin host', async () => {
    setSettings({ apiBaseUrl: 'https://attacker.evil.example', readKey: 'r-prod-SECRET-readkey' })
    let seenAuth: string | null = 'UNSET'
    let hit = false
    server.use(
      http.get('https://attacker.evil.example/v1/logs', ({ request }) => {
        hit = true
        seenAuth = request.headers.get('authorization')
        return HttpResponse.json({ items: [], nextCursor: null } satisfies LogsResponse)
      }),
    )

    await getLogs(new URLSearchParams({ app: 'billing' }))

    // The request may still go out (server decides), but the secret must not ride along.
    expect(hit).toBe(true)
    expect(seenAuth).toBeNull()
  })

  it('does NOT leak the read key cross-origin for stats either', async () => {
    setSettings({ apiBaseUrl: 'https://attacker.evil.example', readKey: 'r-prod-SECRET-readkey' })
    let seenAuth: string | null = 'UNSET'
    server.use(
      http.get('https://attacker.evil.example/v1/stats', ({ request }) => {
        seenAuth = request.headers.get('authorization')
        return HttpResponse.json({ buckets: [], totals: { count: 0 } })
      }),
    )

    await getStats(new URLSearchParams()).catch(() => {})

    expect(seenAuth).toBeNull()
  })

  it('STILL sends the Authorization header when apiBaseUrl is an absolute SAME-origin URL', async () => {
    // location.origin is http://localhost:3000 in the jsdom test env. A same-origin
    // absolute base URL is legitimate (operator's same-origin proxy) and must keep the key.
    setSettings({ apiBaseUrl: 'http://localhost:3000', readKey: 'tb_read_same_origin' })
    let seenAuth: string | null = 'UNSET'
    server.use(
      http.get('http://localhost:3000/v1/logs', ({ request }) => {
        seenAuth = request.headers.get('authorization')
        return HttpResponse.json({ items: [], nextCursor: null } satisfies LogsResponse)
      }),
    )

    await getLogs(new URLSearchParams())

    expect(seenAuth).toBe('Bearer tb_read_same_origin')
  })

  it('appends URLSearchParams as a query string', async () => {
    let seenUrl = ''
    server.use(
      http.get('/v1/logs', ({ request }) => {
        seenUrl = request.url
        return HttpResponse.json({ items: [], nextCursor: null } satisfies LogsResponse)
      }),
    )

    await getLogs(new URLSearchParams({ app: 'api', level: 'error' }))

    const u = new URL(seenUrl)
    expect(u.pathname).toBe('/v1/logs')
    expect(u.searchParams.get('app')).toBe('api')
    expect(u.searchParams.get('level')).toBe('error')
  })

  it('still issues the request with no Authorization header when key is empty (server decides)', async () => {
    setSettings({ readKey: '' })
    let seenAuth: string | null = 'UNSET'
    let hit = false
    server.use(
      http.get('/v1/logs', ({ request }) => {
        hit = true
        seenAuth = request.headers.get('authorization')
        return HttpResponse.json({ items: [], nextCursor: null } satisfies LogsResponse)
      }),
    )

    await getLogs(new URLSearchParams())

    expect(hit).toBe(true)
    expect(seenAuth).toBeNull()
  })

  it('apiGet<T> works for an arbitrary path/shape', async () => {
    server.use(http.get('/v1/custom', () => HttpResponse.json({ hello: 'world' })))

    const res = await apiGet<{ hello: string }>('/v1/custom')

    expect(res.hello).toBe('world')
  })
})

describe('typed endpoint helpers', () => {
  it('getEvents calls /v1/events (params optional)', async () => {
    let hit = false
    server.use(
      http.get('/v1/events', () => {
        hit = true
        return HttpResponse.json({ apps: { api: ['http.'] } })
      }),
    )

    const res = await getEvents()

    expect(hit).toBe(true)
    expect(res.apps.api).toEqual(['http.'])
  })

  it('getFacets calls /v1/facets', async () => {
    server.use(
      http.get('/v1/facets', () =>
        HttpResponse.json({
          window: { from: '2026-06-13T00:00:00.000Z', to: '2026-06-14T00:00:00.000Z' },
          idsKeys: ['userEmail'],
          dataPaths: ['latencyMs'],
        }),
    ),
    )

    const res = await getFacets(new URLSearchParams())

    expect(res.idsKeys).toEqual(['userEmail'])
  })

  it('getGroupBy calls /v1/groupby', async () => {
    server.use(
      http.get('/v1/groupby', () =>
        HttpResponse.json({ by: 'app', total: 5, groups: [{ value: 'api', count: 5 }], otherCount: 0 }),
      ),
    )

    const res = await getGroupBy(new URLSearchParams({ by: 'app' }))

    expect(res.by).toBe('app')
    expect(res.groups[0].count).toBe(5)
  })

  it('getHealth calls /healthz (no params)', async () => {
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

    const res = await getHealth()

    expect(hit).toBe(true)
    expect(res.ok).toBe(true)
    expect(res.mongo.connected).toBe(true)
  })
})
