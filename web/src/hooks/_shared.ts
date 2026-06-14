// Internal helpers shared by the data hooks (contract C-F8). Not part of the
// public surface — hooks are re-exported from hooks/index.ts.
import { loadSettings } from '@/lib/settings'

/**
 * Whether a read key is configured. All data hooks gate `enabled` on this so no
 * request fires before the user has pasted a key (spec §9: queries paused).
 * Read fresh on every render so a SettingsDialog change re-enables the queries.
 */
export function hasReadKey(): boolean {
  return loadSettings().readKey !== ''
}

/** The tail polling interval (ms) from settings; used by useLiveTail. */
export function tailIntervalMs(): number {
  return loadSettings().tailIntervalMs
}
