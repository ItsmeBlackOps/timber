// Typed fetch client for the Timber query API (contract C-F2).
// Base URL + read key come from settings (C-F5); a call sends
// `Authorization: Bearer <key>` when a key is present AND the request resolves
// to our own origin (the key is never sent off-origin — see isSameOrigin).
// Non-2xx responses throw ApiError carrying the status + parsed body so the UI
// can branch (401/503).

import { loadSettings } from '@/lib/settings'
import { ApiError } from '@/lib/types'
import type {
  LogsResponse,
  StatsResponse,
  EventsResponse,
  FacetsResponse,
  GroupByResponse,
  Health,
  Project,
  ProjectsResponse,
  JobsResponse,
} from '@/lib/types'

/**
 * Does `url` (relative or absolute) resolve to our own origin? Used to gate the
 * Bearer read key so it is never sent off-origin. A relative URL (empty
 * apiBaseUrl) and an absolute same-origin URL both pass; a cross-origin or
 * unparseable URL fails closed. Kept local to the request path so the gate
 * cannot be defeated by mocking another module.
 */
function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, location.origin).origin === location.origin
  } catch {
    return false
  }
}

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
 * read key from settings when set AND the request resolves to our own origin
 * (the key is never transmitted to a foreign host). Throws {@link ApiError} on a
 * non-OK status.
 */
export async function apiGet<T>(path: string, params?: URLSearchParams): Promise<T> {
  const { apiBaseUrl, readKey } = loadSettings()
  const qs = params ? params.toString() : ''
  const url = (apiBaseUrl || '') + path + (qs ? `?${qs}` : '')

  const headers: Record<string, string> = { accept: 'application/json' }
  // SECURITY (read-key exfiltration / SSRF-to-wrong-origin): apiBaseUrl is
  // operator-settable free text with no host validation. Only attach the Bearer
  // read key when the resolved request URL stays on our own origin, so a
  // misconfigured/hostile base URL can never carry the key to a foreign host —
  // regardless of how apiBaseUrl was populated (Settings UI, or a future URL
  // param / imported view / postMessage). Defence-in-depth alongside the
  // save-time validation in SettingsDialog.
  if (readKey && isSameOrigin(url)) headers.authorization = `Bearer ${readKey}`

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

// Mutating requests (projects CRUD). Mirrors apiGet's same-origin Bearer gate and
// ApiError-on-non-2xx; returns null for 204 (DELETE).
async function apiSend<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T | null> {
  const { apiBaseUrl, readKey } = loadSettings()
  const url = (apiBaseUrl || '') + path
  const headers: Record<string, string> = { accept: 'application/json' }
  if (readKey && isSameOrigin(url)) headers.authorization = `Bearer ${readKey}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  if (!res.ok) throw new ApiError(res.status, await readBody(res))
  if (res.status === 204) return null
  return (await res.json()) as T
}

export const getProjects = () => apiGet<ProjectsResponse>('/v1/projects')
export const createProject = (body: { name: string; apps: string[] }) =>
  apiSend<Project>('POST', '/v1/projects', body)
export const updateProject = (body: { slug: string; name?: string; apps?: string[] }) =>
  apiSend<Project>('PATCH', '/v1/projects', body)
export const deleteProject = (slug: string) =>
  apiSend<null>('DELETE', `/v1/projects?slug=${encodeURIComponent(slug)}`)
export const getJobs = (p?: URLSearchParams) => apiGet<JobsResponse>('/v1/jobs', p)
