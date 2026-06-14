// Contract C-F3 — the search contract. Maps Filters <-> URLSearchParams,
// mirroring the server's query parser (contract C8, src/query/logs.js):
//   level=<csv>, app=, env=, event=, q=, from=, to=, ids.<key>=,
//   data.<path>= (eq), data.<path>__gte=, data.<path>__lte=, limit=.
// All filter state lives in the URL (shareable / bookmarkable / back-forward
// = filter history), so these two functions are exact inverses (the single
// intentional asymmetry: an all-4 levels selection serializes to no `level`
// param — "all levels" and "no constraint" are the same thing on the wire).
//
// Pagination (`cursor=`) is owned by useInfiniteQuery and is deliberately
// neither emitted nor parsed here.
import type { Level } from '@/lib/types'

/** A single `ids.<key>=value` equality row. */
export interface IdFilter {
  key: string
  value: string
}

/** A single `data.<path>` row: `eq` -> `data.<path>=`, `gte`/`lte` -> `__gte`/`__lte`. */
export interface DataFilter {
  path: string
  op: 'eq' | 'gte' | 'lte'
  value: string
}

/** The complete, URL-serializable filter state for the logs query. */
export interface Filters {
  app?: string
  env?: string
  levels: Level[]
  event?: string
  q?: string
  from?: string
  to?: string
  ids: IdFilter[]
  data: DataFilter[]
  limit?: number
}

/** The four severity levels in server order (debug < info < warn < error). */
export const ALL_LEVELS: Level[] = ['debug', 'info', 'warn', 'error']

const LEVEL_SET = new Set<string>(ALL_LEVELS)

const GTE_SUFFIX = '__gte'
const LTE_SUFFIX = '__lte'
const IDS_PREFIX = 'ids.'
const DATA_PREFIX = 'data.'

/** Integer (incl. negative) — matches the server's INT_RE for `limit`. */
const INT_RE = /^-?\d+$/

/** Append a scalar param only when it is a non-empty string. */
function appendScalar(p: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined && value !== '') p.set(key, value)
}

/**
 * Serialize Filters into URLSearchParams (mirror of server contract C8).
 * Omits unset/empty scalars; omits `level` when no levels OR all four are
 * selected; never emits `cursor`.
 */
export function filtersToParams(f: Filters): URLSearchParams {
  const p = new URLSearchParams()

  appendScalar(p, 'app', f.app)
  appendScalar(p, 'env', f.env)
  appendScalar(p, 'event', f.event)
  appendScalar(p, 'q', f.q)
  appendScalar(p, 'from', f.from)
  appendScalar(p, 'to', f.to)

  // levels -> csv, but only when it is a *constraint*: omit empty and omit all-4.
  const levelCount = f.levels.length
  if (levelCount > 0 && levelCount < ALL_LEVELS.length) {
    p.set('level', f.levels.join(','))
  }

  for (const { key, value } of f.ids) {
    if (key) p.append(IDS_PREFIX + key, value)
  }

  for (const { path, op, value } of f.data) {
    if (!path) continue
    const name =
      op === 'gte'
        ? DATA_PREFIX + path + GTE_SUFFIX
        : op === 'lte'
          ? DATA_PREFIX + path + LTE_SUFFIX
          : DATA_PREFIX + path
    p.append(name, value)
  }

  if (f.limit !== undefined) p.set('limit', String(f.limit))

  return p
}

/**
 * Parse URLSearchParams back into Filters. Inverse of filtersToParams and
 * tolerant of missing/garbage keys: unknown level tokens and a non-integer
 * `limit` are dropped, `cursor` is ignored, bare `ids.`/`data.` (no path) are
 * skipped.
 */
export function paramsToFilters(p: URLSearchParams): Filters {
  const f: Filters = { levels: [], ids: [], data: [] }

  for (const [name, value] of p.entries()) {
    if (name === 'app') {
      f.app = value
    } else if (name === 'env') {
      f.env = value
    } else if (name === 'event') {
      f.event = value
    } else if (name === 'q') {
      f.q = value
    } else if (name === 'from') {
      f.from = value
    } else if (name === 'to') {
      f.to = value
    } else if (name === 'level') {
      for (const token of value.split(',')) {
        const t = token.trim()
        if (LEVEL_SET.has(t)) f.levels.push(t as Level)
      }
    } else if (name === 'limit') {
      if (INT_RE.test(value)) f.limit = Number(value)
    } else if (name.startsWith(IDS_PREFIX) && name.length > IDS_PREFIX.length) {
      f.ids.push({ key: name.slice(IDS_PREFIX.length), value })
    } else if (name.startsWith(DATA_PREFIX) && name.length > DATA_PREFIX.length) {
      if (name.endsWith(GTE_SUFFIX)) {
        const path = name.slice(DATA_PREFIX.length, -GTE_SUFFIX.length)
        if (path) f.data.push({ path, op: 'gte', value })
      } else if (name.endsWith(LTE_SUFFIX)) {
        const path = name.slice(DATA_PREFIX.length, -LTE_SUFFIX.length)
        if (path) f.data.push({ path, op: 'lte', value })
      } else {
        f.data.push({ path: name.slice(DATA_PREFIX.length), op: 'eq', value })
      }
    }
    // anything else (incl. `cursor`) is intentionally ignored.
  }

  return f
}
