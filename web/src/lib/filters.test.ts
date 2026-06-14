// Contract C-F3: filters.ts maps Filters <-> URLSearchParams, mirroring server
// contract C8 (src/query/logs.js). Every row of the §7 table is covered below,
// plus the round-trip property paramsToFilters(filtersToParams(f)) ~= f
// (levels compared order-insensitively).
import {
  ALL_LEVELS,
  filtersToParams,
  paramsToFilters,
  type DataFilter,
  type Filters,
  type IdFilter,
} from '@/lib/filters'
import type { Level } from '@/lib/types'

/** A fully-empty Filters value (the canonical "no filter" state). */
function emptyFilters(): Filters {
  return { levels: [], ids: [], data: [] }
}

describe('ALL_LEVELS', () => {
  it('matches the server LEVELS order debug<info<warn<error', () => {
    expect(ALL_LEVELS).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('is exported as a Level[] usable as a default selection', () => {
    const f: Filters = { ...emptyFilters(), levels: [...ALL_LEVELS] }
    // all-4 selected is treated as "no level constraint" => omitted
    expect(filtersToParams(f).has('level')).toBe(false)
  })
})

describe('filtersToParams — §7 rows', () => {
  it('app -> app=', () => {
    const p = filtersToParams({ ...emptyFilters(), app: 'billing' })
    expect(p.get('app')).toBe('billing')
  })

  it('env -> env=', () => {
    const p = filtersToParams({ ...emptyFilters(), env: 'prod' })
    expect(p.get('env')).toBe('prod')
  })

  it('event prefix -> event=', () => {
    const p = filtersToParams({ ...emptyFilters(), event: 'ai.' })
    expect(p.get('event')).toBe('ai.')
  })

  it('free-text -> q=', () => {
    const p = filtersToParams({ ...emptyFilters(), q: 'timeout|refused' })
    expect(p.get('q')).toBe('timeout|refused')
  })

  it('time range -> from= + to=', () => {
    const from = '2026-06-14T00:00:00.000Z'
    const to = '2026-06-14T06:00:00.000Z'
    const p = filtersToParams({ ...emptyFilters(), from, to })
    expect(p.get('from')).toBe(from)
    expect(p.get('to')).toBe(to)
  })

  it('id rows -> ids.<key>=value (one param per row, key embedded in name)', () => {
    const ids: IdFilter[] = [
      { key: 'userEmail', value: 'a@x.com' },
      { key: 'requestId', value: 'req_123' },
    ]
    const p = filtersToParams({ ...emptyFilters(), ids })
    expect(p.get('ids.userEmail')).toBe('a@x.com')
    expect(p.get('ids.requestId')).toBe('req_123')
  })

  it('data eq -> data.<path>=value', () => {
    const data: DataFilter[] = [{ path: 'status', op: 'eq', value: '500' }]
    const p = filtersToParams({ ...emptyFilters(), data })
    expect(p.get('data.status')).toBe('500')
    expect(p.has('data.status__gte')).toBe(false)
  })

  it('data gte -> data.<path>__gte=value', () => {
    const data: DataFilter[] = [{ path: 'latencyMs', op: 'gte', value: '300' }]
    const p = filtersToParams({ ...emptyFilters(), data })
    expect(p.get('data.latencyMs__gte')).toBe('300')
  })

  it('data lte -> data.<path>__lte=value', () => {
    const data: DataFilter[] = [{ path: 'latencyMs', op: 'lte', value: '1000' }]
    const p = filtersToParams({ ...emptyFilters(), data })
    expect(p.get('data.latencyMs__lte')).toBe('1000')
  })

  it('supports gte AND lte on the same path (a range)', () => {
    const data: DataFilter[] = [
      { path: 'latencyMs', op: 'gte', value: '300' },
      { path: 'latencyMs', op: 'lte', value: '1000' },
    ]
    const p = filtersToParams({ ...emptyFilters(), data })
    expect(p.get('data.latencyMs__gte')).toBe('300')
    expect(p.get('data.latencyMs__lte')).toBe('1000')
  })

  it('limit -> limit= when set', () => {
    const p = filtersToParams({ ...emptyFilters(), limit: 250 })
    expect(p.get('limit')).toBe('250')
  })

  it('limit=0 is still emitted (explicit), but undefined is omitted', () => {
    expect(filtersToParams({ ...emptyFilters(), limit: 0 }).get('limit')).toBe('0')
    expect(filtersToParams({ ...emptyFilters() }).has('limit')).toBe(false)
  })
})

describe('filtersToParams — levels csv (omit-when-all / omit-when-empty)', () => {
  it('omits level when no levels selected (empty array)', () => {
    expect(filtersToParams(emptyFilters()).has('level')).toBe(false)
  })

  it('omits level when all 4 are selected', () => {
    const f: Filters = { ...emptyFilters(), levels: ['debug', 'info', 'warn', 'error'] }
    expect(filtersToParams(f).has('level')).toBe(false)
  })

  it('omits level when all 4 are selected regardless of order', () => {
    const f: Filters = { ...emptyFilters(), levels: ['error', 'debug', 'warn', 'info'] }
    expect(filtersToParams(f).has('level')).toBe(false)
  })

  it('emits a single csv for a partial selection', () => {
    const f: Filters = { ...emptyFilters(), levels: ['warn', 'error'] }
    const p = filtersToParams(f)
    expect(p.get('level')).toBe('warn,error')
    // exactly one level param, not one-per-level
    expect(p.getAll('level')).toEqual(['warn,error'])
  })

  it('emits a single level for a single selection', () => {
    const f: Filters = { ...emptyFilters(), levels: ['error'] }
    expect(filtersToParams(f).get('level')).toBe('error')
  })
})

describe('filtersToParams — omission of unset / empty scalars', () => {
  it('omits scalar keys that are undefined', () => {
    const p = filtersToParams(emptyFilters())
    for (const k of ['app', 'env', 'event', 'q', 'from', 'to', 'level', 'limit']) {
      expect(p.has(k)).toBe(false)
    }
  })

  it('omits scalar keys that are the empty string', () => {
    const f: Filters = {
      ...emptyFilters(),
      app: '',
      env: '',
      event: '',
      q: '',
      from: '',
      to: '',
    }
    const p = filtersToParams(f)
    for (const k of ['app', 'env', 'event', 'q', 'from', 'to']) {
      expect(p.has(k)).toBe(false)
    }
  })

  it('NEVER emits a cursor param (infinite-query owns pagination)', () => {
    const f: Filters = {
      app: 'billing',
      env: 'prod',
      levels: ['error'],
      event: 'ai.',
      q: 'x',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      ids: [{ key: 'userEmail', value: 'a@x.com' }],
      data: [{ path: 'latencyMs', op: 'gte', value: '300' }],
      limit: 100,
    }
    expect(filtersToParams(f).has('cursor')).toBe(false)
  })
})

describe('paramsToFilters — inverse, tolerant of missing keys', () => {
  it('returns the empty Filters for empty params (arrays present, scalars absent)', () => {
    const f = paramsToFilters(new URLSearchParams())
    expect(f).toEqual(emptyFilters())
  })

  it('parses every scalar row', () => {
    const p = new URLSearchParams({
      app: 'billing',
      env: 'prod',
      event: 'ai.',
      q: 'boom',
      from: '2026-06-14T00:00:00.000Z',
      to: '2026-06-14T06:00:00.000Z',
      limit: '250',
    })
    const f = paramsToFilters(p)
    expect(f.app).toBe('billing')
    expect(f.env).toBe('prod')
    expect(f.event).toBe('ai.')
    expect(f.q).toBe('boom')
    expect(f.from).toBe('2026-06-14T00:00:00.000Z')
    expect(f.to).toBe('2026-06-14T06:00:00.000Z')
    expect(f.limit).toBe(250)
  })

  it('parses level csv into a Level[] (preserving the listed levels)', () => {
    const f = paramsToFilters(new URLSearchParams({ level: 'warn,error' }))
    expect(f.levels).toEqual(['warn', 'error'])
  })

  it('ignores empty/whitespace level tokens and unknown levels', () => {
    const f = paramsToFilters(new URLSearchParams({ level: 'warn, ,error,bogus,' }))
    expect(f.levels).toEqual(['warn', 'error'])
  })

  it('parses ids.<key>= into IdFilter rows', () => {
    const p = new URLSearchParams()
    p.append('ids.userEmail', 'a@x.com')
    p.append('ids.requestId', 'req_1')
    const f = paramsToFilters(p)
    expect(f.ids).toEqual<IdFilter[]>([
      { key: 'userEmail', value: 'a@x.com' },
      { key: 'requestId', value: 'req_1' },
    ])
  })

  it('parses data.<path> as eq, __gte as gte, __lte as lte', () => {
    const p = new URLSearchParams()
    p.append('data.status', '500')
    p.append('data.latencyMs__gte', '300')
    p.append('data.latencyMs__lte', '1000')
    const f = paramsToFilters(p)
    expect(f.data).toEqual<DataFilter[]>([
      { path: 'status', op: 'eq', value: '500' },
      { path: 'latencyMs', op: 'gte', value: '300' },
      { path: 'latencyMs', op: 'lte', value: '1000' },
    ])
  })

  it('is tolerant of an invalid limit (drops it rather than throwing)', () => {
    expect(paramsToFilters(new URLSearchParams({ limit: 'abc' })).limit).toBeUndefined()
    expect(paramsToFilters(new URLSearchParams({ limit: '' })).limit).toBeUndefined()
  })

  it('ignores an inbound cursor param (not part of Filters)', () => {
    const f = paramsToFilters(new URLSearchParams({ cursor: 'abc', app: 'billing' }))
    expect(f.app).toBe('billing')
    expect('cursor' in f).toBe(false)
  })

  it('ignores a bare ids. / data. with no path', () => {
    const p = new URLSearchParams()
    p.append('ids.', 'x')
    p.append('data.', 'y')
    const f = paramsToFilters(p)
    expect(f.ids).toEqual([])
    expect(f.data).toEqual([])
  })

  it('treats data.<path>__gte with an empty path as a literal eq path (mirrors server guard)', () => {
    // server rejects bare "data.__gte"; here the leftover path would be empty,
    // so we must not produce a {path:'', op:'gte'} row.
    const p = new URLSearchParams()
    p.append('data.__gte', '5')
    const f = paramsToFilters(p)
    expect(f.data).toEqual([])
  })
})

describe('round-trip property: paramsToFilters(filtersToParams(f)) ~= f', () => {
  // Deterministic pseudo-random generator (mulberry32) so failures reproduce.
  function rng(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a |= 0
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  const LEVELS: Level[] = ['debug', 'info', 'warn', 'error']
  const ID_KEYS = ['userEmail', 'requestId', 'sessionId', 'orgId']
  const DATA_PATHS = ['latencyMs', 'durationMs', 'status', 'costUsd', 'nested.code']
  const OPS: DataFilter['op'][] = ['eq', 'gte', 'lte']

  function pick<T>(r: () => number, arr: T[]): T {
    return arr[Math.floor(r() * arr.length)]
  }
  function maybe(r: () => number, p: number): boolean {
    return r() < p
  }

  function genFilters(r: () => number): Filters {
    const levelCount = Math.floor(r() * 5) // 0..4
    const shuffled = [...LEVELS].sort(() => r() - 0.5)
    const levels = shuffled.slice(0, levelCount)

    const ids: IdFilter[] = []
    const idCount = Math.floor(r() * 3)
    for (let i = 0; i < idCount; i++) {
      ids.push({ key: pick(r, ID_KEYS), value: `v${Math.floor(r() * 1000)}` })
    }

    const data: DataFilter[] = []
    const dataCount = Math.floor(r() * 3)
    for (let i = 0; i < dataCount; i++) {
      data.push({
        path: pick(r, DATA_PATHS),
        op: pick(r, OPS),
        value: String(Math.floor(r() * 5000)),
      })
    }

    const f: Filters = { levels, ids, data }
    if (maybe(r, 0.6)) f.app = pick(r, ['billing', 'auth', 'web', 'worker'])
    if (maybe(r, 0.5)) f.env = pick(r, ['prod', 'staging', 'dev'])
    if (maybe(r, 0.5)) f.event = pick(r, ['ai.', 'db.query', 'cron.run', 'http.'])
    if (maybe(r, 0.4)) f.q = pick(r, ['boom', 'timeout|refused', 'user 42'])
    if (maybe(r, 0.4)) f.from = '2026-06-14T00:00:00.000Z'
    if (maybe(r, 0.4)) f.to = '2026-06-14T06:00:00.000Z'
    if (maybe(r, 0.5)) f.limit = 1 + Math.floor(r() * 500)
    return f
  }

  /**
   * The wire form has one intentional asymmetry: an all-4 levels selection
   * serializes to NO `level` param (all levels == no constraint), so it
   * round-trips back to []. Normalize that single case before comparing.
   */
  function normLevels(levels: Level[]): Level[] {
    return levels.length === LEVELS.length ? [] : levels
  }

  /** Compare two Filters with levels order-insensitive; everything else exact. */
  function expectEquivalent(a: Filters, b: Filters): void {
    const al = normLevels(a.levels)
    expect(new Set(al)).toEqual(new Set(b.levels))
    expect(al.length).toBe(b.levels.length)
    const rest = (f: Filters) => ({
      app: f.app,
      env: f.env,
      event: f.event,
      q: f.q,
      from: f.from,
      to: f.to,
      ids: f.ids,
      data: f.data,
      limit: f.limit,
    })
    expect(rest(a)).toEqual(rest(b))
  }

  it('round-trips 500 generated Filters values', () => {
    const r = rng(0xc0ffee)
    for (let i = 0; i < 500; i++) {
      const f = genFilters(r)
      const back = paramsToFilters(filtersToParams(f))
      expectEquivalent(f, back)
    }
  })

  it('round-trips the all-levels case to an EMPTY levels array (all-4 == none on the wire)', () => {
    // This is the one intentional asymmetry: selecting all 4 omits `level`, so
    // the inverse yields []. The UI treats [] and all-4 identically (no constraint).
    const f: Filters = { ...emptyFilters(), levels: [...ALL_LEVELS] }
    const back = paramsToFilters(filtersToParams(f))
    expect(back.levels).toEqual([])
  })

  it('round-trips a fully-populated representative value exactly', () => {
    const f: Filters = {
      app: 'billing',
      env: 'prod',
      levels: ['warn', 'error'],
      event: 'ai.request',
      q: 'rate.?limit',
      from: '2026-06-14T00:00:00.000Z',
      to: '2026-06-14T12:00:00.000Z',
      ids: [
        { key: 'userEmail', value: 'a@x.com' },
        { key: 'requestId', value: 'req_42' },
      ],
      data: [
        { path: 'status', op: 'eq', value: '500' },
        { path: 'latencyMs', op: 'gte', value: '300' },
        { path: 'latencyMs', op: 'lte', value: '2000' },
      ],
      limit: 200,
    }
    expectEquivalent(f, paramsToFilters(filtersToParams(f)))
  })
})
