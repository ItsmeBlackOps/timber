// Task 7 — Jobs dashboard (/jobs). Per-job rollups for a window, optionally
// scoped to a project.
//
// One row per job from /v1/jobs (run counts, success rate, latency percentiles,
// last-run status). The Name cell drills into Explore filtered to that job's
// events (carrying the project scope), so a failing cron is one click from its
// raw logs. Status is rendered as BOTH a text label and a colored dot so it's
// never color-only (WCAG 1.4.1). Range/project live in the URL like the other
// routes; the data hook self-gates on a read key.
import { useMemo } from 'react'
import { Link, useSearch } from '@tanstack/react-router'

import { useJobs } from '@/hooks'
import { useSettings } from '@/hooks/useSettings'

/** Default window: last 24h. Mirrors the helper in explore.tsx. */
function last24h(): { from: string; to: string } {
  const now = Date.now()
  return {
    from: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(now).toISOString(),
  }
}

const cellStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--tb-border)',
  fontSize: 13,
  textAlign: 'left',
  verticalAlign: 'top',
  whiteSpace: 'nowrap',
}

const headStyle: React.CSSProperties = {
  ...cellStyle,
  color: 'var(--tb-mut)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  fontSize: 11,
}

const numCell: React.CSSProperties = {
  ...cellStyle,
  fontVariantNumeric: 'tabular-nums',
}

function fmtPercent(rate: number | null): string {
  return rate == null ? 'n/a' : `${Math.round(rate * 100)}%`
}

function fmtMs(v: number | null): string {
  return v == null ? 'n/a' : `${v} ms`
}

/** A status label + colored dot (not color-only). */
function StatusCell({ status }: { status: 'ok' | 'failed' }) {
  const failed = status === 'failed'
  return (
    <td style={cellStyle}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: failed ? 'var(--tb-error)' : 'var(--tb-ok, #1a8f4c)',
            display: 'inline-block',
          }}
        />
        <span>{failed ? 'Failed' : 'OK'}</span>
      </span>
    </td>
  )
}

/**
 * Jobs dashboard route. Reads `project` from the URL and shows a table of per-job
 * rollups; each Name links into Explore filtered to that job's events.
 */
export function JobsRoute() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>
  const project =
    typeof rawSearch.project === 'string' && rawSearch.project !== ''
      ? rawSearch.project
      : undefined

  const hasReadKey = useSettings().readKey !== ''

  // Stable last-24h window so the query key doesn't churn every render.
  const range = useMemo(() => last24h(), [])
  const q = useJobs(range, project)
  const jobs = q.data?.jobs ?? []

  // Omit `project` from the drill-in search when undefined (keeps the URL clean).
  const projScope = project !== undefined ? { project } : {}

  return (
    <div style={{ padding: 16, display: 'grid', gap: 12 }}>
      <h1 style={{ margin: 0, fontSize: 20 }}>
        Jobs <span style={{ color: 'var(--tb-mut)', fontWeight: 400 }}>· {project ?? 'All projects'}</span>
      </h1>

      {!hasReadKey ? (
        <div role="note" style={{ color: 'var(--tb-mut)', fontSize: 14 }}>
          Set a read key in Settings to load jobs.
        </div>
      ) : q.isPending ? (
        <div style={{ color: 'var(--tb-mut)', fontSize: 14 }}>Loading…</div>
      ) : q.isError ? (
        <div role="alert" style={{ color: 'var(--tb-error)', fontSize: 14 }}>
          Could not load jobs.
        </div>
      ) : jobs.length === 0 ? (
        <div style={{ color: 'var(--tb-mut)', fontSize: 14 }}>No jobs in this window.</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            data-testid="jobs-table"
            style={{ borderCollapse: 'collapse', width: '100%', minWidth: 720 }}
          >
            <caption style={{ textAlign: 'left', color: 'var(--tb-mut)', fontSize: 12, paddingBottom: 8 }}>
              Job runs over the last 24 hours
            </caption>
            <thead>
              <tr>
                <th scope="col" style={headStyle}>Name</th>
                <th scope="col" style={headStyle}>Last run</th>
                <th scope="col" style={headStyle}>Status</th>
                <th scope="col" style={headStyle}>Success rate</th>
                <th scope="col" style={headStyle}>p50</th>
                <th scope="col" style={headStyle}>p95</th>
                <th scope="col" style={headStyle}>Runs</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((row) => (
                <tr key={row.name}>
                  <td style={cellStyle}>
                    <Link
                      to="/"
                      search={{ ...projScope, event: row.name }}
                      style={{ color: 'var(--tb-acc)', textDecoration: 'none' }}
                    >
                      {row.name}
                    </Link>
                  </td>
                  <td style={cellStyle}>{row.lastRunAt}</td>
                  <StatusCell status={row.lastStatus} />
                  <td style={numCell}>{fmtPercent(row.successRate)}</td>
                  <td style={numCell}>{fmtMs(row.p50Ms)}</td>
                  <td style={numCell}>{fmtMs(row.p95Ms)}</td>
                  <td style={numCell}>
                    {row.runs}
                    {row.failures > 0 ? (
                      <span style={{ color: 'var(--tb-mut)' }}> ({row.failures} failed)</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
