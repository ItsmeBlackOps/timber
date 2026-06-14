// Task F11 — Stats dashboard (contract C-F10 / spec §8.3).
//
// Renders the headline MetricCards plus the full StatChart set (volume, error
// rate, AI cost, tokens, latency) from /v1/stats, with an hour/day grouping
// toggle and a range-preset picker. Range (`from`/`to`) and `app` live in the URL
// using the SAME keys as the Explore filter contract (C-F3), so the time window
// and app pivot are shared across the two views. A "top by" strip reuses
// /v1/groupby for the top services, users and models over the current scope.
//
// The route owns its URL state directly via useSearch({strict:false}) + useNavigate
// (the F0 router declares no validateSearch); filter edits use `replace` so the
// back button steps through views, not every slider nudge.
import { useMemo } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'

import { MetricCards } from '@/components/MetricCards'
import { StatChart } from '@/components/StatChart'
import type { StatChartKind } from '@/components/StatChart'
import { useGroupBy, useStats } from '@/hooks'
import type { Filters } from '@/lib/filters'
import { loadSettings } from '@/lib/settings'
import { PRESETS, presetRange } from '@/lib/time'

type Group = 'hour' | 'day'

/** The slice of the URL this route reads. All optional, all strings on the wire. */
interface StatsSearch {
  app?: string
  event?: string
  from?: string
  to?: string
  group?: Group
}

const DEFAULT_RANGE_ID = '24h'
const DEFAULT_GROUP: Group = 'hour'

/** Charts rendered top-to-bottom, with a human title for the section heading. */
const CHARTS: { kind: StatChartKind; title: string }[] = [
  { kind: 'volume', title: 'Event volume' },
  { kind: 'errorRate', title: 'Error rate' },
  { kind: 'cost', title: 'AI cost' },
  { kind: 'tokens', title: 'Token usage' },
  { kind: 'latency', title: 'Latency' },
]

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined
}

/** Read the typed search slice from the loose (strict:false) search object. */
function readSearch(raw: Record<string, unknown>): StatsSearch {
  const group = raw.group === 'day' ? 'day' : raw.group === 'hour' ? 'hour' : undefined
  return {
    app: asString(raw.app),
    event: asString(raw.event),
    from: asString(raw.from),
    to: asString(raw.to),
    group,
  }
}

/** Which preset id (if any) the current window length corresponds to, for highlighting. */
function activePresetId(from: string, to: string): string | null {
  const span = new Date(to).getTime() - new Date(from).getTime()
  if (!Number.isFinite(span)) return null
  const hit = PRESETS.find((p) => Math.abs(p.ms - span) <= 1000)
  return hit ? hit.id : null
}

const btnBase: React.CSSProperties = {
  border: '1px solid var(--tb-border)',
  background: 'var(--tb-surface)',
  color: 'var(--tb-text)',
  borderRadius: 6,
  padding: '4px 10px',
  fontSize: 13,
  cursor: 'pointer',
}

function activeStyle(active: boolean): React.CSSProperties {
  return active
    ? { background: 'var(--tb-acc)', color: '#fff', borderColor: 'var(--tb-acc)' }
    : {}
}

/** One column of the top-by strip: a labeled list of {value,count} bars. */
function TopByColumn({
  title,
  by,
  filters,
}: {
  title: string
  by: string
  filters: Filters
}) {
  const { data, isLoading } = useGroupBy(by, filters, { limit: 5 })
  const groups = data?.groups ?? []
  const max = groups.reduce((m, g) => Math.max(m, g.count), 0) || 1

  return (
    <div
      data-testid={`top-by-${by}`}
      style={{
        flex: '1 1 0',
        minWidth: 160,
        background: 'var(--tb-surface)',
        border: '1px solid var(--tb-border)',
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div
        style={{
          fontSize: 12,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: 'var(--tb-mut)',
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {isLoading && groups.length === 0 ? (
        <div style={{ color: 'var(--tb-mut)', fontSize: 13 }}>Loading…</div>
      ) : groups.length === 0 ? (
        <div style={{ color: 'var(--tb-mut)', fontSize: 13 }}>No data</div>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          {groups.map((g) => {
            const label = g.value === null ? '∅' : String(g.value)
            return (
              <li key={label} style={{ display: 'grid', gap: 2 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: 8,
                    fontSize: 13,
                  }}
                >
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'var(--tb-text)',
                    }}
                    title={label}
                  >
                    {label}
                  </span>
                  <span style={{ color: 'var(--tb-mut)', fontVariantNumeric: 'tabular-nums' }}>
                    {g.count}
                  </span>
                </div>
                <div
                  aria-hidden
                  style={{ height: 4, background: 'var(--tb-2)', borderRadius: 2 }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.round((g.count / max) * 100)}%`,
                      background: 'var(--tb-acc)',
                      borderRadius: 2,
                    }}
                  />
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

/**
 * Stats dashboard route. Range/app are URL-shared with Explore; group is a local
 * URL param. Everything refetches reactively off the query keys in the hooks.
 */
export function StatsRoute() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>
  const navigate = useNavigate()
  const search = readSearch(rawSearch)

  // A stable default window when the URL carries none, so the query key doesn't
  // churn every render (which would refetch in a loop).
  const defaultRange = useMemo(() => presetRange(DEFAULT_RANGE_ID, new Date()), [])
  const from = search.from ?? defaultRange.from
  const to = search.to ?? defaultRange.to
  const group = search.group ?? DEFAULT_GROUP
  const app = search.app
  const event = search.event

  const range = useMemo(() => ({ from, to }), [from, to])

  const statsQuery = useStats(range, group, app, event)

  // Scope the top-by breakdowns to the same window + app + event as the charts.
  const scopeFilters = useMemo<Filters>(
    () => ({ app, event, from, to, levels: [], ids: [], data: [] }),
    [app, event, from, to],
  )

  // The default identity key for "top users" comes from settings (C-F5), read
  // fresh so a SettingsDialog change re-scopes the breakdown.
  const userKey = loadSettings().userKeys[0] ?? 'userEmail'

  function setGroup(next: Group) {
    void navigate({ to: '/stats', search: (prev) => ({ ...prev, group: next }), replace: true })
  }

  function setRange(presetId: string) {
    const win = presetRange(presetId, new Date())
    void navigate({
      to: '/stats',
      search: (prev) => ({ ...prev, from: win.from, to: win.to }),
      replace: true,
    })
  }

  const activePreset = activePresetId(from, to)

  return (
    <div style={{ padding: 16, display: 'grid', gap: 20 }}>
      {/* Controls: range presets (shared `from`/`to`) + grouping toggle */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div role="group" aria-label="Time range" style={{ display: 'flex', gap: 6 }}>
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={activePreset === p.id}
              onClick={() => setRange(p.id)}
              style={{ ...btnBase, ...activeStyle(activePreset === p.id) }}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div role="group" aria-label="Group by interval" style={{ display: 'flex', gap: 6 }}>
          {(['hour', 'day'] as const).map((g) => (
            <button
              key={g}
              type="button"
              aria-pressed={group === g}
              onClick={() => setGroup(g)}
              style={{ ...btnBase, ...activeStyle(group === g), textTransform: 'capitalize' }}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      {statsQuery.isError ? (
        <div role="alert" style={{ color: 'var(--tb-error)' }}>
          Could not load stats.
        </div>
      ) : null}

      <MetricCards stats={statsQuery.data} />

      {/* Top-by strip: top services / users / models over the current scope */}
      <div
        data-testid="top-by-strip"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}
      >
        <TopByColumn title="Top services" by="app" filters={scopeFilters} />
        <TopByColumn title="Top users" by={`ids.${userKey}`} filters={scopeFilters} />
        <TopByColumn title="Top models" by="data.model" filters={scopeFilters} />
      </div>

      {/* Charts */}
      <div style={{ display: 'grid', gap: 20 }}>
        {CHARTS.map(({ kind, title }) => (
          <section key={kind} style={{ display: 'grid', gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 14, color: 'var(--tb-mut)', fontWeight: 600 }}>
              {title}
            </h2>
            <StatChart buckets={statsQuery.data?.buckets ?? []} kind={kind} />
          </section>
        ))}
      </div>
    </div>
  )
}
