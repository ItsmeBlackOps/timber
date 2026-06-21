// useGroupBy — top-N counts per distinct value of one field from /v1/groupby
// (contract C-F8). Powers the GroupByPanel breakdown bars and FindBy value
// autocomplete. Reuses the logs filter serialization (C-F3) for scoping — the
// server applies the same filter builder (C-S2) minus cursor.
import { useQuery } from '@tanstack/react-query'

import { getGroupBy } from '@/lib/api'
import { filtersToParams } from '@/lib/filters'
import type { Filters } from '@/lib/filters'
import type { GroupByResponse } from '@/lib/types'
import { useHasReadKey } from './_shared'

export interface UseGroupByOptions {
  /** Top-N values to return (server clamps 1..100, default 20). */
  limit?: number
  /** Case-insensitive substring to filter values (value autocomplete). */
  like?: string
  /** Caller gate (ANDed with the read-key gate). Default true. */
  enabled?: boolean
}

/**
 * Query GET /v1/groupby?by=<field> over the current filter + window.
 * `enabled` = the option (default true) AND a read key is present.
 */
export function useGroupBy(by: string, filters: Filters, options: UseGroupByOptions = {}) {
  const { limit, like, enabled = true } = options
  // Hoisted (not behind &&) so the hook is called unconditionally every render.
  const hasKey = useHasReadKey()

  return useQuery<GroupByResponse>({
    queryKey: ['groupby', by, filtersToParams(filters).toString(), limit ?? null, like ?? null],
    queryFn: () => {
      // filtersToParams never emits cursor, so this is the scoped filter set.
      const params = filtersToParams(filters)
      params.set('by', by)
      if (limit !== undefined) params.set('limit', String(limit))
      if (like) params.set('like', like)
      return getGroupBy(params)
    },
    enabled: enabled && hasKey,
  })
}
