// Tests for the projects/jobs hooks (contract C-F8). MSW mocks the network; a
// fresh QueryClient per test (retry off, no gc) keeps cases isolated. Mirrors
// hooks.test.tsx: the same reactive @/lib/settings mock keeps useHasReadKey true.
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor, act } from '@testing-library/react'

import { server } from '../../test/msw-server'
import { PROJECTS_RESPONSE, JOBS_RESPONSE } from '../../test/fixtures'
import type { Settings } from '@/lib/settings'

// The hooks' enabled gate reads settings reactively via useSyncExternalStore
// (useSettings), so the mock exposes loadSettings + getSnapshot + subscribe.
// getSnapshot reads the mocked loadSettings, so the read-key gate is on.
const settingsMock = vi.hoisted(() => ({ loadSettings: vi.fn() }))
vi.mock('@/lib/settings', () => ({
  loadSettings: settingsMock.loadSettings,
  getSnapshot: () => settingsMock.loadSettings(),
  subscribe: () => () => {},
}))

import { useProjects, useJobs } from '@/hooks'

const BASE_SETTINGS: Settings = {
  apiBaseUrl: '',
  readKey: 'tb_read', // hooks enabled
  theme: 'system',
  tailIntervalMs: 2000,
  userKeys: ['userEmail', 'userId'],
  slowMs: 300,
}

settingsMock.loadSettings.mockReturnValue(BASE_SETTINGS)

/** A QueryClientProvider wrapper backed by a throwaway client (no retries). */
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
})
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

beforeEach(() => {
  settingsMock.loadSettings.mockReturnValue(BASE_SETTINGS)
  queryClient.clear()
})

test('useProjects.query lists projects', async () => {
  const { result } = renderHook(() => useProjects(), { wrapper })
  await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
  expect(result.current.query.data?.projects).toHaveLength(2)
})

test('create mutation invalidates the projects list', async () => {
  let gets = 0
  server.use(
    http.get('/v1/projects', () => { gets++; return HttpResponse.json(PROJECTS_RESPONSE) }),
    http.post('/v1/projects', () => HttpResponse.json({ slug: 'n', name: 'N', apps: [] }, { status: 201 })),
  )
  const { result } = renderHook(() => useProjects(), { wrapper })
  await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
  await act(async () => { await result.current.create.mutateAsync({ name: 'N', apps: [] }) })
  await waitFor(() => expect(gets).toBeGreaterThanOrEqual(2))
})

test('useJobs passes the project param', async () => {
  let seen: URLSearchParams | undefined
  server.use(http.get('/v1/jobs', ({ request }) => { seen = new URL(request.url).searchParams; return HttpResponse.json(JOBS_RESPONSE) }))
  const { result } = renderHook(() => useJobs({ from: 'A', to: 'B' }, 'acme'), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(seen?.get('project')).toBe('acme')
})
