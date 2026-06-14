// useEvents — the known apps + their event prefixes from /v1/events
// (contract C-F8). Powers the AppSwitcher and EventCombobox suggestions.
import { useQuery } from '@tanstack/react-query'

import { getEvents } from '@/lib/api'
import type { EventsResponse } from '@/lib/types'
import { hasReadKey } from './_shared'

/** Query GET /v1/events (no params). Disabled until a read key is set. */
export function useEvents() {
  return useQuery<EventsResponse>({
    queryKey: ['events'],
    queryFn: () => getEvents(),
    enabled: hasReadKey(),
  })
}
