// useStats — bucketed rollups from /v1/stats (contract C-F8). Params mirror the
// server (C9): group=hour|day, from/to window, optional app (exact) + event
// (prefix). Range/app are shared with Explore via the URL.
import { useQuery } from '@tanstack/react-query'

import { getStats } from '@/lib/api'
import type { StatsResponse } from '@/lib/types'
import { hasReadKey } from './_shared'

export interface TimeRange {
  from: string
  to: string
}

/** Query GET /v1/stats for the given window + grouping. Disabled with no key. */
export function useStats(
  range: TimeRange,
  group: 'hour' | 'day',
  app?: string,
  event?: string,
) {
  return useQuery<StatsResponse>({
    queryKey: ['stats', range.from, range.to, group, app ?? null, event ?? null],
    queryFn: () => {
      const params = new URLSearchParams()
      params.set('group', group)
      params.set('from', range.from)
      params.set('to', range.to)
      if (app) params.set('app', app)
      if (event) params.set('event', event)
      return getStats(params)
    },
    enabled: hasReadKey(),
  })
}
