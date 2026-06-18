// Internal helpers shared by the data hooks (contract C-F8). Not part of the
// public surface — hooks are re-exported from hooks/index.ts.
import { loadSettings } from '@/lib/settings'
import { useSettings } from './useSettings'

/**
 * Non-reactive read-key check (one-off reads outside React). Inside hooks or
 * components, prefer the reactive useHasReadKey().
 */
export function hasReadKey(): boolean {
  return loadSettings().readKey !== ''
}

/** Non-reactive tail interval (ms). Inside React, prefer useTailIntervalMs(). */
export function tailIntervalMs(): number {
  return loadSettings().tailIntervalMs
}

/**
 * REACTIVE read-key gate. Data hooks gate `enabled` on this so queries re-enable
 * the instant a key is saved (this tab) or arrives from another tab — without
 * waiting for an incidental re-render (spec §9: queries paused until a key).
 */
export function useHasReadKey(): boolean {
  return useSettings().readKey !== ''
}

/** REACTIVE tail polling interval (ms); used by useLiveTail. */
export function useTailIntervalMs(): number {
  return useSettings().tailIntervalMs
}
