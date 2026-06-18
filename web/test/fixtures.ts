// Shared test fixtures for the Timber Console (Task F13).
//
// These are PRD §5.2-style events — three events from three different worlds,
// same endpoint — plus canned responses for every query endpoint. They are the
// single source of sample data for the MSW handler set (./handlers.ts) and are
// re-usable directly in component/route tests that want realistic shapes.
//
// The shapes are typed against the C-F1 contract (`@/lib/types`) so a drift in
// the response contract breaks the fixtures at typecheck time, not at runtime.
import type {
  EventsResponse,
  FacetsResponse,
  GroupByResponse,
  Health,
  LogDoc,
  LogsResponse,
  StatsResponse,
} from '@/lib/types'

// ---------------------------------------------------------------------------
// Log documents — PRD §5.2 (an AI call, a slow DB query, a cron run).
// Each carries `receivedAt`/`expiresAt` (server-stamped) and a server `_id`.
// ---------------------------------------------------------------------------

/**
 * An AI call. Carries the PRD §5.2 cost/token/latency fields AND a
 * `data.request`/`data.response` pair so the DetailPanel's two-pane
 * request/response inspector (ReqResView) lights up — this is the product's
 * core "view anything" experience. Correlated by `ids.userEmail` (+ taskId).
 */
export const aiRequestLog: LogDoc = {
  _id: '000000000000000000000001',
  app: 'api',
  env: 'prod',
  event: 'ai.request',
  level: 'info',
  ts: '2026-06-14T05:00:00.000Z',
  message: 'opus draft generated',
  ids: { userEmail: 'anna@example.com', taskId: '6a2877' },
  data: {
    provider: 'opusmax',
    model: 'claude-opus-4-8',
    inputTokens: 9120,
    outputTokens: 2330,
    latencyMs: 41200,
    status: 200,
    costUsd: 0.31,
    request: {
      model: 'claude-opus-4-8',
      messages: [{ role: 'user', content: 'Draft a follow-up email.' }],
      temperature: 0.2,
    },
    response: {
      status: 200,
      finishReason: 'end_turn',
      text: 'Here is your follow-up email...',
    },
  },
  receivedAt: '2026-06-14T05:00:00.120Z',
  expiresAt: '2026-07-14T05:00:00.120Z',
}

/** A slow database query (PRD §5.2). warn-level; latency + scan counters. */
export const dbQueryLog: LogDoc = {
  _id: '000000000000000000000002',
  app: 'worker',
  env: 'prod',
  event: 'db.query',
  level: 'warn',
  ts: '2026-06-14T05:01:00.000Z',
  message: 'slow visibility query',
  ids: { userEmail: 'anna@example.com', requestId: 'req-77' },
  data: {
    collection: 'taskBody',
    operation: 'aggregate',
    query: '{ interviewStartAt: {$gte..}, $or:[sender,cc regex] }',
    latencyMs: 2773,
    keysExamined: 39816,
    docsExamined: 4979,
  },
  receivedAt: '2026-06-14T05:01:00.080Z',
  expiresAt: '2026-07-14T05:01:00.080Z',
}

/** A cron run (PRD §5.2). info-level; uses `durationMs` (not `latencyMs`). */
export const cronRunLog: LogDoc = {
  _id: '000000000000000000000003',
  app: 'scheduler',
  env: 'prod',
  event: 'cron.run',
  level: 'info',
  ts: '2026-06-14T05:02:00.000Z',
  message: 'candidate alert sweep complete',
  ids: { jobId: 'job-412' },
  data: {
    job: 'candidateAlertScheduler',
    scanned: 412,
    alerted: 9,
    errors: 0,
    durationMs: 8120,
  },
  receivedAt: '2026-06-14T05:02:00.060Z',
  expiresAt: '2026-07-14T05:02:00.060Z',
}

/** The three canonical events, newest first (descending `receivedAt`). */
export const SAMPLE_LOGS: LogDoc[] = [cronRunLog, dbQueryLog, aiRequestLog]

// ---------------------------------------------------------------------------
// Canned endpoint responses derived from the sample logs.
// ---------------------------------------------------------------------------

/** A single page of all sample logs, cursor exhausted. */
export const LOGS_RESPONSE: LogsResponse = {
  items: SAMPLE_LOGS,
  nextCursor: null,
}

/** The window every fixture response reports. */
export const SAMPLE_WINDOW = {
  from: '2026-06-13T05:00:00.000Z',
  to: '2026-06-14T05:00:00.000Z',
} as const

/** Apps + event prefixes matching the sample logs (drives AppSwitcher / EventCombobox). */
export const EVENTS_RESPONSE: EventsResponse = {
  apps: {
    api: ['ai.request', 'http.request'],
    worker: ['db.query'],
    scheduler: ['cron.run'],
  },
}

/** Discoverable facet fields covering the sample logs' ids + data keys. */
export const FACETS_RESPONSE: FacetsResponse = {
  window: { ...SAMPLE_WINDOW },
  idsKeys: ['jobId', 'requestId', 'taskId', 'userEmail'],
  dataPaths: ['costUsd', 'durationMs', 'latencyMs', 'model', 'status'],
}

/** Two stat buckets: one busy hour (with cost/tokens/latency), one quiet hour. */
export const STATS_RESPONSE: StatsResponse = {
  group: 'hour',
  from: SAMPLE_WINDOW.from,
  to: SAMPLE_WINDOW.to,
  buckets: [
    {
      bucket: '2026-06-14T04:00:00.000Z',
      total: 120,
      counts: { debug: 4, info: 100, warn: 14, error: 2 },
      latency: { p50: 22, p95: 410, p99: 980 },
      errorRate: 1.67,
      costUsd: 0.31,
      inputTokens: 9120,
      outputTokens: 2330,
    },
    {
      bucket: '2026-06-14T05:00:00.000Z',
      total: 3,
      counts: { debug: 0, info: 2, warn: 1, error: 0 },
      latency: null,
      errorRate: null,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    },
  ],
}

/** "Errors by user" style breakdown — used by GroupByPanel + the Stats "top by" strip. */
export const GROUPBY_RESPONSE: GroupByResponse = {
  by: 'ids.userEmail',
  total: 14,
  groups: [
    { value: 'anna@example.com', count: 9 },
    { value: 'bob@example.com', count: 3 },
  ],
  otherCount: 2,
  window: { from: '2026-06-17T12:00:00.000Z', to: '2026-06-18T12:00:00.000Z' },
}

/** Healthy service: WAL caught up, flusher running, Mongo connected. */
export const HEALTH_RESPONSE: Health = {
  ok: true,
  wal: { totalBytes: 4096, backlogBytes: 0, overBudget: false },
  flusher: { running: true, caughtUp: true, flushedTotal: 1234, lastError: null },
  mongo: { connected: true },
}
