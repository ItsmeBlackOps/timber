// useLogs — infinite log query (contract C-F8). Builds the request from the
// URL-mirroring Filters (C-F3), walks the opaque forward cursor, and returns a
// flat `items` array across all loaded pages.
import { useInfiniteQuery } from '@tanstack/react-query'

import { getLogs } from '@/lib/api'
import { filtersToParams } from '@/lib/filters'
import type { Filters } from '@/lib/filters'
import type { LogDoc, LogsResponse } from '@/lib/types'
import { useHasReadKey } from './_shared'

/**
 * Infinite query over GET /v1/logs.
 *
 * - `queryFn` appends `cursor=<pageParam>` to the serialized filters (page 1 has
 *   no cursor — pageParam is null).
 * - `getNextPageParam = last.nextCursor`; a null cursor ends pagination
 *   (`hasNextPage` → false).
 * - `items` flattens `data.pages` in load order.
 * Disabled until a read key is set (spec §9).
 */
export function useLogs(filters: Filters) {
  const query = useInfiniteQuery<LogsResponse>({
    queryKey: ['logs', filtersToParams(filters).toString()],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = filtersToParams(filters)
      if (typeof pageParam === 'string' && pageParam !== '') params.set('cursor', pageParam)
      return getLogs(params)
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: useHasReadKey(),
  })

  const items: LogDoc[] = (query.data?.pages ?? []).flatMap((p) => p.items)

  return { ...query, items }
}
