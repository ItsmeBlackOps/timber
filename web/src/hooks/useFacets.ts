// useFacets — discover available facet fields (ids.* keys, data.* paths) in a
// window from /v1/facets (contract C-F8). Drives the FindBy key picker and the
// GroupBy dimension list. Params (C-S1): optional app scope + from/to window.
import { useQuery } from '@tanstack/react-query'

import { getFacets } from '@/lib/api'
import type { FacetsResponse } from '@/lib/types'
import { useHasReadKey } from './_shared'
import type { TimeRange } from './useStats'

/** Query GET /v1/facets for the window (+ optional app). Disabled with no key. */
export function useFacets(app: string | undefined, range: TimeRange) {
  return useQuery<FacetsResponse>({
    queryKey: ['facets', app ?? null, range.from, range.to],
    queryFn: () => {
      const params = new URLSearchParams()
      if (app) params.set('app', app)
      params.set('from', range.from)
      params.set('to', range.to)
      return getFacets(params)
    },
    enabled: useHasReadKey(),
  })
}
