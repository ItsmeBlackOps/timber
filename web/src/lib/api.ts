// Typed fetch client for the Timber query API (contract C-F2).
// Base URL + read key come from settings (C-F5); every call sends
// `Authorization: Bearer <key>` when a key is present. Non-2xx responses throw
// ApiError carrying the status + parsed body so the UI can branch (401/503).

import { loadSettings } from '@/lib/settings'
import { ApiError } from '@/lib/types'
import type {
  LogsResponse,
  StatsResponse,
  EventsResponse,
  FacetsResponse,
  GroupByResponse,
  Health,
} from '@/lib/types'

/** Parse a response body as JSON, falling back to raw text (e.g. proxy/plain errors). */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * GET `(apiBaseUrl || '') + path` with optional query params. Sends the Bearer
 * read key from settings when set. Throws {@link ApiError} on a non-OK status.
 */
export async function apiGet<T>(path: string, params?: URLSearchParams): Promise<T> {
  const { apiBaseUrl, readKey } = loadSettings()
  const qs = params ? params.toString() : ''
  const url = (apiBaseUrl || '') + path + (qs ? `?${qs}` : '')

  const headers: Record<string, string> = { accept: 'application/json' }
  if (readKey) headers.authorization = `Bearer ${readKey}`

  const res = await fetch(url, { headers })
  if (!res.ok) {
    throw new ApiError(res.status, await readBody(res))
  }
  return (await res.json()) as T
}

export const getLogs = (p: URLSearchParams) => apiGet<LogsResponse>('/v1/logs', p)
export const getStats = (p: URLSearchParams) => apiGet<StatsResponse>('/v1/stats', p)
export const getEvents = (p?: URLSearchParams) => apiGet<EventsResponse>('/v1/events', p)
export const getFacets = (p: URLSearchParams) => apiGet<FacetsResponse>('/v1/facets', p)
export const getGroupBy = (p: URLSearchParams) => apiGet<GroupByResponse>('/v1/groupby', p)
export const getHealth = () => apiGet<Health>('/healthz')
