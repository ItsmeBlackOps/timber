// useJobs — job rollups from /v1/jobs (contract C-F8) for a window, optionally
// scoped to a project (and/or a single app). Disabled until a read key is set.
import { useQuery } from '@tanstack/react-query'

import { getJobs } from '@/lib/api'
import type { JobsResponse } from '@/lib/types'
import type { TimeRange } from './useStats'
import { useHasReadKey } from './_shared'

export function useJobs(range: TimeRange, project?: string, app?: string) {
  return useQuery<JobsResponse>({
    queryKey: ['jobs', range.from, range.to, project ?? null, app ?? null],
    queryFn: () => {
      const p = new URLSearchParams()
      p.set('from', range.from)
      p.set('to', range.to)
      if (project) p.set('project', project)
      if (app) p.set('app', app)
      return getJobs(p)
    },
    enabled: useHasReadKey(),
  })
}
