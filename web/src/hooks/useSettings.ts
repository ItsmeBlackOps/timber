// Reactive settings (contract C-F5). Backed by useSyncExternalStore so any
// consumer re-renders the instant settings change — in this tab (saveSettings →
// 'timber:settings' event) or another tab (native 'storage' event) — instead of
// only when an incidental re-render happens. getSnapshot reuses loadSettings'
// raw-string cache, preserving the C-F5 referential-identity contract.
import { useSyncExternalStore } from "react";

import { getSnapshot, subscribe } from "@/lib/settings";
import type { Settings } from "@/lib/settings";

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
