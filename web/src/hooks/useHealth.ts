// useHealth — service liveness + WAL/flusher/mongo state from /healthz
// (contract C-F8). Polls every 10s for the header health dot. Unlike the data
// hooks this is NOT gated on a read key — /healthz needs no auth (C-F2), so the
// dot works even before a key is pasted.
import { useQuery } from '@tanstack/react-query'

import { getHealth } from '@/lib/api'
import type { Health } from '@/lib/types'

const HEALTH_POLL_MS = 10_000

/** Query GET /healthz, refetching every 10s. Always enabled (no key needed). */
export function useHealth() {
  return useQuery<Health>({
    queryKey: ['health'],
    queryFn: () => getHealth(),
    refetchInterval: HEALTH_POLL_MS,
  })
}
