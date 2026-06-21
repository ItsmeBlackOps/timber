// useEvents — the known apps + their event prefixes from /v1/events
// (contract C-F8). Powers the AppSwitcher and EventCombobox suggestions.
import { useQuery } from '@tanstack/react-query'

import { getEvents } from '@/lib/api'
import type { EventsResponse } from '@/lib/types'
import { useHasReadKey } from './_shared'

/** Query GET /v1/events (optional project scope). Disabled until a read key is set. */
export function useEvents(project?: string) {
  return useQuery<EventsResponse>({
    queryKey: ['events', project ?? null],
    queryFn: () => getEvents(project ? new URLSearchParams({ project }) : undefined),
    enabled: useHasReadKey(),
  })
}
