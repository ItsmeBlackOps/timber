// C-F4 — curated lenses + user-saved views.

import type { DataFilter, Filters } from "@/lib/filters";

/** Tunables a lens reads from settings when building its filter. */
export interface ViewCfg {
  userKeys: string[];
  slowMs: number;
}

/**
 * A curated one-click view: a filter transform plus an optional group-by.
 * `icon` is a lucide-react icon name resolved by the UI (LensRail).
 */
export interface Lens {
  id: string;
  label: string;
  icon: string;
  apply: (base: Filters, cfg: ViewCfg) => Filters;
  groupBy?: string;
}

/** Shallow-clone filters so `apply` never mutates the caller's object. */
function clone(base: Filters): Filters {
  return {
    ...base,
    levels: [...base.levels],
    ids: base.ids.map((f) => ({ ...f })),
    data: base.data.map((f) => ({ ...f })),
  };
}

/** Append a data filter only if an identical one isn't already present. */
function withData(base: Filters, df: DataFilter): Filters {
  const next = clone(base);
  const exists = next.data.some(
    (d) => d.path === df.path && d.op === df.op && d.value === df.value,
  );
  if (!exists) next.data.push(df);
  return next;
}

export const BUILTIN_LENSES: Lens[] = [
  {
    id: "errors",
    label: "Errors & warnings",
    icon: "AlertTriangle",
    apply: (base) => ({ ...clone(base), levels: ["warn", "error"] }),
  },
  {
    id: "ai-usage",
    label: "AI usage",
    icon: "Sparkles",
    apply: (base) => ({ ...clone(base), event: "ai." }),
  },
  {
    id: "by-user",
    label: "By user",
    icon: "Users",
    apply: (base) => clone(base),
    groupBy: "ids.userEmail",
  },
  {
    id: "by-service",
    label: "By service",
    icon: "Server",
    apply: (base) => clone(base),
    groupBy: "app",
  },
  {
    id: "slow-ops",
    label: "Slow operations",
    icon: "Timer",
    apply: (base, cfg) =>
      withData(base, { path: "latencyMs", op: "gte", value: String(cfg.slowMs) }),
  },
  {
    id: "cron",
    label: "Cron & jobs",
    icon: "Clock",
    apply: (base) => ({ ...clone(base), event: "cron." }),
  },
];

// `by-user` groups by the primary configured user key. The static catalog uses
// the default ('userEmail'); a settings-aware builder can be layered on later.

export interface SavedView {
  id: string;
  name: string;
  params: string; // serialized URLSearchParams
}

const SAVED_KEY = "timber.savedViews";

/** Load saved views; corrupt/missing/non-array storage → []. */
export function loadSavedViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedView[]) : [];
  } catch {
    return [];
  }
}

function writeSavedViews(views: SavedView[]): void {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(views));
  } catch {
    // ignore storage failures
  }
}

/** Upsert a saved view by id (update in place, else append). */
export function saveView(v: SavedView): void {
  const views = loadSavedViews();
  const i = views.findIndex((x) => x.id === v.id);
  if (i >= 0) views[i] = v;
  else views.push(v);
  writeSavedViews(views);
}

/** Remove a saved view by id (no-op when absent). */
export function deleteView(id: string): void {
  writeSavedViews(loadSavedViews().filter((v) => v.id !== id));
}
