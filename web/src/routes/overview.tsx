// Task 6 — per-project Overview dashboard (spec: Projects + per-project lenses).
//
// A compact, six-card "front page" for a project (or for all projects when no
// `project` slug is in the URL). Each card is a single lens onto the project's
// recent activity over a fixed last-24h window, with a headline number (or a
// short list) and a TanStack-Router <Link> that drills into the matching detail
// view (Explore / Stats / Jobs) carrying the same `project` scope.
//
// Like Explore/Stats, the route owns its URL state via useSearch({strict:false})
// and every data hook is scoped by `project`. The data hooks self-gate on a read
// key (useHasReadKey inside each hook), so with no key configured the queries
// simply never fire; we additionally show the standard "set a read key" hint so
// the page isn't a silent set of empty cards.
import { useMemo } from 'react'
import { Link, useSearch } from '@tanstack/react-router'

import { useGroupBy, useJobs, useStats } from '@/hooks'
import type { Filters } from '@/lib/filters'
import { ALL_LEVELS } from '@/lib/filters'
import { useSettings } from '@/hooks/useSettings'

/** Default lens window: last 24h. Mirrors the helper in explore.tsx. */
function last24h(): { from: string; to: string } {
  const now = Date.now()
  return {
    from: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(now).toISOString(),
  }
}

const cardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 16,
  borderRadius: 10,
  border: '1px solid var(--tb-border)',
  background: 'var(--tb-surface)',
  minWidth: 0,
}

const cardTitle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--tb-mut)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

const bigNumber: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  color: 'var(--tb-text)',
  fontVariantNumeric: 'tabular-nums',
  lineHeight: 1.1,
}

const subLabel: React.CSSProperties = {
  fontSize: 13,
  color: 'var(--tb-mut)',
}

const drillLink: React.CSSProperties = {
  marginTop: 'auto',
  fontSize: 13,
  color: 'var(--tb-acc)',
  textDecoration: 'none',
}

const placeholder = <span style={bigNumber}>…</span>

/** A {value: count} list shared by the by-user / by-service cards. */
function GroupList({
  groups,
}: {
  groups: { value: string | number | boolean | null; count: number }[]
}) {
  if (groups.length === 0) {
    return <div style={subLabel}>No data</div>
  }
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
      {groups.map((g) => {
        const label = g.value === null ? '∅' : String(g.value)
        return (
          <li
            key={label}
            style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}
          >
            <span
              title={label}
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--tb-text)',
              }}
            >
              {label}
            </span>
            <span style={{ color: 'var(--tb-mut)', fontVariantNumeric: 'tabular-nums' }}>
              {g.count}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * Project Overview route. Reads `project` (slug) from the URL; every lens query
 * is auto-scoped to it. With no `project` the cards summarize all projects.
 */
export function OverviewRoute() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>
  const project =
    typeof rawSearch.project === 'string' && rawSearch.project !== ''
      ? rawSearch.project
      : undefined

  const settings = useSettings()
  const hasReadKey = settings.readKey !== ''

  // Stable last-24h window so the query keys don't churn every render.
  const range = useMemo(() => last24h(), [])

  // One base filter set scoped to the project; the group-by cards reuse it.
  const baseFilters = useMemo<Filters>(
    () => ({ levels: ALL_LEVELS, ids: [], data: [], project }),
    [project],
  )
  const slowFilters = useMemo<Filters>(
    () => ({ ...baseFilters, data: [{ path: 'data.latencyMs', op: 'gte', value: String(settings.slowMs) }] }),
    [baseFilters, settings.slowMs],
  )

  // Shared stats series powers both the errors and the AI-usage cards.
  const stats = useStats(range, 'hour', undefined, undefined, project)
  const byUser = useGroupBy('ids.userEmail', baseFilters, { limit: 5 })
  const byService = useGroupBy('app', baseFilters, { limit: 10 })
  const slow = useGroupBy('app', slowFilters, { limit: 10 })
  const jobs = useJobs(range, project)

  const buckets = stats.data?.buckets ?? []
  const warnError = buckets.reduce((s, b) => s + b.counts.warn + b.counts.error, 0)
  const costUsd = buckets.reduce((s, b) => s + b.costUsd, 0)
  const tokens = buckets.reduce((s, b) => s + b.inputTokens + b.outputTokens, 0)

  const jobRows = jobs.data?.jobs ?? []
  const failedJobs = jobRows.filter((j) => j.lastStatus === 'failed').length
  const slowCount = slow.data?.total ?? 0

  // Drill-in search objects. Omit the `project` key entirely when undefined so
  // the URL stays clean (an `undefined` value would otherwise be serialized).
  const projScope = project !== undefined ? { project } : {}

  return (
    <div style={{ padding: 16, display: 'grid', gap: 16 }}>
      <h1 style={{ margin: 0, fontSize: 20 }}>
        Overview <span style={{ color: 'var(--tb-mut)', fontWeight: 400 }}>· {project ?? 'All projects'}</span>
      </h1>

      {!hasReadKey ? (
        <div role="note" style={{ color: 'var(--tb-mut)', fontSize: 14 }}>
          Set a read key in Settings to load project data.
        </div>
      ) : null}

      <div
        role="list"
        style={{
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        }}
      >
        {/* Errors and warnings */}
        <div role="listitem" data-testid="overview-errors" style={cardStyle}>
          <h2 style={cardTitle}>Errors and warnings</h2>
          {stats.isPending ? placeholder : <span style={bigNumber}>{warnError}</span>}
          <span style={subLabel}>warnings + errors (24h)</span>
          <Link to="/" search={{ ...projScope, level: 'warn,error' }} style={drillLink}>
            View in Explore →
          </Link>
        </div>

        {/* AI usage */}
        <div role="listitem" data-testid="overview-ai-usage" style={cardStyle}>
          <h2 style={cardTitle}>AI usage</h2>
          {stats.isPending ? (
            placeholder
          ) : (
            <span style={bigNumber}>${costUsd.toFixed(2)}</span>
          )}
          <span style={subLabel}>
            {stats.isPending ? '…' : `${tokens.toLocaleString()} tokens (24h)`}
          </span>
          <Link to="/stats" search={{ ...projScope }} style={drillLink}>
            View in Stats →
          </Link>
        </div>

        {/* By user */}
        <div role="listitem" data-testid="overview-by-user" style={cardStyle}>
          <h2 style={cardTitle}>By user</h2>
          {byUser.isPending ? placeholder : <GroupList groups={byUser.data?.groups ?? []} />}
          <Link to="/" search={{ ...projScope }} style={drillLink}>
            View in Explore →
          </Link>
        </div>

        {/* By service */}
        <div role="listitem" data-testid="overview-by-service" style={cardStyle}>
          <h2 style={cardTitle}>By service</h2>
          {byService.isPending ? placeholder : <GroupList groups={byService.data?.groups ?? []} />}
          <Link to="/" search={{ ...projScope }} style={drillLink}>
            View in Explore →
          </Link>
        </div>

        {/* Slow operations */}
        <div role="listitem" data-testid="overview-slow-ops" style={cardStyle}>
          <h2 style={cardTitle}>Slow operations</h2>
          {slow.isPending ? placeholder : <span style={bigNumber}>{slowCount}</span>}
          <span style={subLabel}>over {settings.slowMs} ms (24h)</span>
          <Link
            to="/"
            search={{ ...projScope, 'data.latencyMs__gte': String(settings.slowMs) }}
            style={drillLink}
          >
            View in Explore →
          </Link>
        </div>

        {/* Cron and jobs */}
        <div role="listitem" data-testid="overview-cron" style={cardStyle}>
          <h2 style={cardTitle}>Cron and jobs</h2>
          {jobs.isPending ? (
            placeholder
          ) : (
            <span style={bigNumber}>{jobRows.length}</span>
          )}
          <span style={subLabel}>
            {jobs.isPending ? '…' : `${jobRows.length} jobs · ${failedJobs} failing (24h)`}
          </span>
          <Link to="/jobs" search={{ ...projScope }} style={drillLink}>
            View jobs →
          </Link>
        </div>
      </div>
    </div>
  )
}
