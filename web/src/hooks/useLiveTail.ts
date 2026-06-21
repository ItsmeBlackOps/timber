// useLiveTail — polls page 1 of /v1/logs for the live tail (contract C-F8).
// Refetches every settings.tailIntervalMs, but ONLY while enabled, a read key
// is set, and the tab is visible (spec §8.2: pause when document is hidden so a
// backgrounded tab stops hammering the API). Dedupe/prepend is the caller's job.
import { useQuery } from '@tanstack/react-query'

import { getLogs } from '@/lib/api'
import { filtersToParams } from '@/lib/filters'
import type { Filters } from '@/lib/filters'
import type { LogDoc, LogsResponse } from '@/lib/types'
import { useHasReadKey, useTailIntervalMs } from './_shared'

function isVisible(): boolean {
  // jsdom + browsers both expose document.visibilityState.
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

/**
 * Poll the newest page (no cursor) while live tail is on.
 * `enabled` = caller's toggle AND a read key is present AND the tab is visible.
 * `refetchInterval` also returns false when hidden so an in-flight interval
 * stops without waiting for a re-render.
 */
export function useLiveTail(filters: Filters, enabled: boolean) {
  // Reactive reads (hoisted, called unconditionally) so a saved key / changed
  // interval takes effect immediately — in this tab or another.
  const hasKey = useHasReadKey()
  const tailMs = useTailIntervalMs()
  const active = enabled && hasKey && isVisible()

  const query = useQuery<LogsResponse>({
    queryKey: ['liveTail', filtersToParams(filters).toString()],
    // Page 1 only — never sends a cursor.
    queryFn: () => getLogs(filtersToParams(filters)),
    enabled: active,
    refetchInterval: () => (isVisible() ? tailMs : false),
    // Don't keep the tab from settling between polls.
    refetchOnWindowFocus: false,
  })

  const items: LogDoc[] = query.data?.items ?? []

  return { ...query, items }
}
