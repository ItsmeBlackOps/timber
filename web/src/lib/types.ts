// Shared API types for the Timber Console (contract C-F1).
// These mirror the server's query-API response shapes (see PRD §6 / USAGE.md).

export type Level = 'debug' | 'info' | 'warn' | 'error'

/** A single log document as returned by GET /v1/logs. */
export interface LogDoc {
  _id: string
  app: string
  env: string
  event: string
  level: Level
  ts?: string
  message?: string
  ids?: Record<string, string>
  /** Arbitrary structured payload; narrowed at use. */
  data?: unknown
  receivedAt: string
  expiresAt: string
}

/** GET /v1/logs — page of documents + opaque forward cursor (null when exhausted). */
export interface LogsResponse {
  items: LogDoc[]
  nextCursor: string | null
}

/** One time bucket in the stats series. `latency`/`errorRate` are null when undefined (render as gaps, not zeros). */
export interface StatsBucket {
  bucket: string
  total: number
  counts: Record<Level, number>
  latency: { p50: number; p95: number; p99: number } | null
  errorRate: number | null
  costUsd: number
  inputTokens: number
  outputTokens: number
}

/** GET /v1/stats — bucketed volume / error-rate / cost / tokens / latency series. */
export interface StatsResponse {
  group: 'hour' | 'day'
  from: string
  to: string
  buckets: StatsBucket[]
}

/** GET /v1/events — known apps and the event prefixes seen for each. */
export interface EventsResponse {
  apps: Record<string, string[]>
}

/** GET /v1/facets — discovered facet field names within the window. */
export interface FacetsResponse {
  window: { from: string; to: string }
  idsKeys: string[]
  dataPaths: string[]
}

/** GET /v1/groupby — top-N counts per distinct value of one field. */
export interface GroupByResponse {
  by: string
  total: number
  groups: { value: string | number | boolean | null; count: number }[]
  otherCount: number
}

/** GET /healthz — service liveness + WAL/flusher/mongo subsystem state. */
export interface Health {
  ok: boolean
  wal: { totalBytes: number; backlogBytes: number; overBudget: boolean }
  flusher: {
    running: boolean
    caughtUp: boolean
    flushedTotal: number
    lastError: string | null
  }
  mongo: { connected: boolean }
}

/**
 * Thrown by the API client on a non-2xx response. Carries the HTTP status and
 * the parsed JSON (or raw text) body so the UI can branch (401 → re-auth, 503 → backoff).
 *
 * NOTE: declared with explicit fields + body assignment rather than TS parameter
 * properties — `erasableSyntaxOnly` (tsconfig) forbids parameter properties because
 * they emit runtime code.
 */
export class ApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}
