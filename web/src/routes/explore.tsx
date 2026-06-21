// F10 — Explore route (contract C-F10, spec §8.2).
//
// The URL search params are the single source of truth for filter state. We read
// them with useSearch({strict:false}) and write them with useNavigate; every
// control (FilterBar, FindBy, lenses, group-by drill-in, pivot-on-value) maps
// onto the same Filters <-> URLSearchParams bridge from lib/filters, so the
// console is fully shareable/bookmarkable and back/forward replays filter
// history. Filter edits use replace (they're not distinct history entries);
// lenses/saved-views push (they're navigations a user expects to undo).
//
// Data: useLogs (infinite cursor) for the table, useLiveTail for the optional
// 2s poll (prepended + deduped by _id), useEvents for the AppSwitcher + the
// group-by dimension list. A 401 from the logs query shows the auth Banner.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";

import { AppSwitcher } from "@/components/AppSwitcher";
import { Banner } from "@/components/Banner";
import { DetailPanel } from "@/components/DetailPanel";
import { FilterBar } from "@/components/FilterBar";
import { FindByBar } from "@/components/FindByBar";
import { GroupByPanel } from "@/components/GroupByPanel";
import { LensRail } from "@/components/LensRail";
import { ResultsTable } from "@/components/ResultsTable";
import type { PivotFragment } from "@/components/JsonTree";
import { useEvents } from "@/hooks/useEvents";
import { useLiveTail } from "@/hooks/useLiveTail";
import { useLogs } from "@/hooks/useLogs";
import { ApiError } from "@/lib/types";
import type { GroupByResponse, LogDoc } from "@/lib/types";
import {
  ALL_LEVELS,
  filtersToParams,
  paramsToFilters,
} from "@/lib/filters";
import type { DataFilter, Filters, IdFilter } from "@/lib/filters";
import { useSettings } from "@/hooks/useSettings";
import {
  deleteView,
  loadSavedViews,
  saveView,
} from "@/lib/views";
import type { Lens, SavedView, ViewCfg } from "@/lib/views";

// ---- URL <-> Filters bridge --------------------------------------------------
// TanStack Router gives us search as a plain object; repeated keys (multiple
// `ids.x` / `data.y`) arrive as arrays. Expand them into URLSearchParams so the
// shared paramsToFilters (C-F3) sees every row.
type SearchObject = Record<string, unknown>;

function searchToParams(search: SearchObject): URLSearchParams {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) if (v !== undefined && v !== null) p.append(key, String(v));
    } else {
      p.append(key, String(value));
    }
  }
  return p;
}

// Inverse: serialize Filters and collapse the params into a plain object,
// grouping repeated keys into arrays so the object round-trips through the URL.
function filtersToSearch(filters: Filters): SearchObject {
  const params = filtersToParams(filters);
  const out: SearchObject = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}

// ---- pivot + drill-in helpers ------------------------------------------------
function withId(filters: Filters, row: IdFilter): Filters {
  const exists = filters.ids.some((i) => i.key === row.key && i.value === row.value);
  if (exists) return filters;
  return { ...filters, ids: [...filters.ids, row] };
}

/** Map a DetailPanel/JsonTree pivot fragment onto the Filters. */
function applyPivot(filters: Filters, frag: PivotFragment): Filters {
  const value = frag.value == null ? "" : String(frag.value);
  if (frag.kind === "ids") {
    return withId(filters, { key: frag.path, value });
  }
  // data path arrives WITH the `data.` prefix; DataFilter.path is the bare path.
  const path = frag.path.startsWith("data.") ? frag.path.slice("data.".length) : frag.path;
  if (!path) return filters;
  const exists = filters.data.some((d) => d.path === path && d.op === "eq" && d.value === value);
  if (exists) return filters;
  return { ...filters, data: [...filters.data, { path, op: "eq", value }] };
}

type GroupValue = GroupByResponse["groups"][number]["value"];

/** Map a group-by `by` dimension + picked value onto the Filters (drill-in). */
function applyGroupPick(filters: Filters, by: string, value: GroupValue): Filters {
  const v = value == null ? "" : String(value);
  if (by === "app") return { ...filters, app: v };
  if (by === "env") return { ...filters, env: v };
  if (by === "event") return { ...filters, event: v };
  if (by === "level") {
    return ALL_LEVELS.includes(v as (typeof ALL_LEVELS)[number])
      ? { ...filters, levels: [v as (typeof ALL_LEVELS)[number]] }
      : filters;
  }
  if (by.startsWith("ids.")) return withId(filters, { key: by.slice("ids.".length), value: v });
  if (by.startsWith("data.")) {
    const path = by.slice("data.".length);
    const exists = filters.data.some((d) => d.path === path && d.op === "eq" && d.value === v);
    return exists ? filters : { ...filters, data: [...filters.data, { path, op: "eq", value: v }] };
  }
  return filters;
}

/** Default discovery window for FindBy/GroupBy: last 24h. */
function last24h(): { from: string; to: string } {
  const now = Date.now();
  return {
    from: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(now).toISOString(),
  };
}

/**
 * Cap on retained tail-only rows. The live tail prepends rows above the loaded
 * page; without a bound a long-running stream would grow the buffer (and the
 * items array) indefinitely. The rest of history is always reachable via normal
 * cursor pagination, so keeping a recent window of tail rows is sufficient. Rows
 * are kept in arrival order (oldest first) and the OLDEST are evicted once the
 * cap is exceeded, so the buffer is a fixed-size FIFO of the most recent arrivals.
 */
const TAIL_BUFFER_MAX = 30;

/**
 * Window event the 401 banner fires to ask the shell (__root) to open the
 * SettingsDialog. The shell owns that dialog's open state, so a decoupled event
 * is cleaner than lifting it up through the router into this leaf route.
 */
const OPEN_SETTINGS_EVENT = "timber:open-settings";

/** Same _id sequence (order-sensitive)? Lets the tail effect skip no-op state sets. */
function sameIds(a: LogDoc[], b: LogDoc[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]._id !== b[i]._id) return false;
  return true;
}

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--tb-mut)",
};

export function ExploreRoute() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as SearchObject;

  // Filters derive purely from the URL — the single source of truth.
  const filters = useMemo(() => paramsToFilters(searchToParams(search)), [search]);
  // A serialized key for the active URL filters: stable per distinct filter set,
  // used to reset the live-tail buffer and the draft advanced rows when filters
  // change (so neither leaks across filters).
  const filterKey = useMemo(() => filtersToParams(filters).toString(), [filters]);

  // Discovery window for FindBy/GroupBy. last24h() returns a fresh object with a
  // millisecond-precision `to` on every call; computing it inline in render would
  // re-key the /v1/facets query on EVERY render (a ~2s refetch loop with live
  // tail on). Memoize it once for the lifetime of the route so the key is stable.
  const findRange = useMemo(() => last24h(), []);

  // View tunables for lenses (user identity keys + slow threshold).
  const settings = useSettings();
  const viewCfg: ViewCfg = useMemo(
    () => ({ userKeys: settings.userKeys, slowMs: settings.slowMs }),
    [settings.userKeys, settings.slowMs],
  );

  // ---- URL writers ----------------------------------------------------------
  const writeFilters = useCallback(
    (next: Filters, opts: { replace: boolean }) => {
      navigate({ to: "/", search: () => filtersToSearch(next), replace: opts.replace });
    },
    [navigate],
  );
  // Filter edits replace; lens/saved-view navigations push (spec §8.2 / C-F10).
  const editFilters = useCallback((next: Filters) => writeFilters(next, { replace: true }), [writeFilters]);
  const pushFilters = useCallback((next: Filters) => writeFilters(next, { replace: false }), [writeFilters]);

  // The 401 banner's action resolves auth, but the SettingsDialog lives in the
  // shell (__root). Ask it to open via an event rather than lifting its state.
  const openSettings = useCallback(() => {
    window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT));
  }, []);

  // ---- data -----------------------------------------------------------------
  const logsQuery = useLogs(filters);
  const logItems = logsQuery.items;

  // Live tail: poll page-1, prepend new rows, dedupe by _id (spec §8.2).
  const [tailOn, setTailOn] = useState(false);
  const tail = useLiveTail(filters, tailOn);
  const tailItems = tail.items;

  // Accumulate tail-only rows (those whose _id isn't already in the page list)
  // across polls so they persist between refetches. The Map lives in a ref but is
  // mutated ONLY inside the effect below (never during render — that's an unsafe
  // anti-pattern and breaks under StrictMode/concurrent double-invoke). The merged
  // result is mirrored into `tailRows` state so a new poll triggers a re-render.
  //
  // Two invariants the effect enforces that the old render-time version did not:
  //   1) Reset on filter change: the buffer is keyed by `filterKey`; when the
  //      active filters change we drop everything so rows captured under the old
  //      filter can never be prepended onto a different filter's results.
  //   2) Bounded size: only the most-recent TAIL_BUFFER_MAX tail-only rows are
  //      retained (insertion-order eviction), so a long-running tail can't grow
  //      the Map / the items array without bound.
  const tailAccum = useRef<Map<string, LogDoc>>(new Map());
  const tailAccumKey = useRef<string>(filterKey);
  const [tailRows, setTailRows] = useState<LogDoc[]>([]);

  useEffect(() => {
    // Tail off: drop the buffer so stale rows don't reappear if it's re-enabled.
    if (!tailOn) {
      if (tailAccum.current.size > 0) tailAccum.current.clear();
      tailAccumKey.current = filterKey;
      setTailRows((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    // Filters changed since the buffer was last filled: discard it entirely.
    if (tailAccumKey.current !== filterKey) {
      tailAccum.current.clear();
      tailAccumKey.current = filterKey;
    }
    const buf = tailAccum.current;
    const pageIds = new Set(logItems.map((d) => d._id));
    for (const doc of tailItems) {
      if (pageIds.has(doc._id)) continue;
      // Re-insert to move an existing id to the most-recent position.
      if (buf.has(doc._id)) buf.delete(doc._id);
      buf.set(doc._id, doc);
    }
    // Evict oldest beyond the cap (Map preserves insertion order).
    while (buf.size > TAIL_BUFFER_MAX) {
      const oldest = buf.keys().next().value as string;
      buf.delete(oldest);
    }
    // Mirror the tail-only rows (excluding any now present in the page) to state.
    const next = [...buf.values()].filter((d) => !pageIds.has(d._id));
    setTailRows((prev) => (sameIds(prev, next) ? prev : next));
  }, [tailOn, tailItems, logItems, filterKey]);

  // Visible rows: tail-only rows (newest first) prepended above the loaded page,
  // deduped by _id (a row promoted into the page list wins).
  const items = useMemo<LogDoc[]>(() => {
    if (tailRows.length === 0) return logItems;
    const pageIds = new Set(logItems.map((d) => d._id));
    const prepended = tailRows.filter((d) => !pageIds.has(d._id));
    return prepended.length === 0 ? logItems : [...prepended, ...logItems];
  }, [tailRows, logItems]);

  const toggleTail = useCallback(() => setTailOn((on) => !on), []);

  // ---- advanced-filter rows (local editing buffer) -------------------------
  // The id/data rows shown in the FilterBar are held in a LOCAL editing buffer
  // rather than read straight from the URL. Two reasons:
  //   - A blank row ({key:'',value:''}) has no URL representation (it's dropped by
  //     filtersToParams), so "Add ID/data filter" rows would vanish on the round
  //     trip and could never be typed into.
  //   - Writing each keystroke to the URL and reading the row back from it leaves
  //     a one-render gap where a freshly-named row is in neither the URL nor the
  //     buffer; the input unmounts mid-type and drops focus, truncating input.
  // The buffer is seeded from the URL on EXTERNAL navigations (lens / saved view /
  // pivot / group-by drill-in) and pushed OUT to the URL (non-empty rows only) on
  // every edit, so the URL stays the shareable source of truth for committed rows.
  const [idRows, setIdRows] = useState<IdFilter[]>(() => filters.ids);
  const [dataRows, setDataRows] = useState<DataFilter[]>(() => filters.data);
  // The filterKey we last wrote ourselves; lets us tell our own URL edits (don't
  // reseed — that would clobber a half-typed row) from external ones (do reseed).
  const lastWrittenKey = useRef<string>(filterKey);
  useEffect(() => {
    if (filterKey === lastWrittenKey.current) return;
    // External navigation changed the URL — adopt its rows into the buffer.
    lastWrittenKey.current = filterKey;
    setIdRows(filters.ids);
    setDataRows(filters.data);
  }, [filterKey, filters.ids, filters.data]);

  // What the FilterBar sees: the live editing buffer (URL scalars + buffered rows).
  const filtersForBar = useMemo<Filters>(
    () => ({ ...filters, ids: idRows, data: dataRows }),
    [filters, idRows, dataRows],
  );

  // FilterBar emits the full next Filters on any change. Keep every row in the
  // buffer (so blank/half-typed rows survive), but write only the non-empty rows
  // to the URL. Scalar fields (level/q/env/from/to/...) always go to the URL.
  const onFilterBarChange = useCallback(
    (next: Filters) => {
      setIdRows(next.ids);
      setDataRows(next.data);
      const committed: Filters = {
        ...next,
        ids: next.ids.filter((r) => r.key !== ""),
        data: next.data.filter((r) => r.path !== ""),
      };
      lastWrittenKey.current = filtersToParams(committed).toString();
      editFilters(committed);
    },
    [editFilters],
  );

  // ---- selection / detail ---------------------------------------------------
  // Cache the selected document itself, not just its id. Deriving the panel doc
  // purely as items.find(id) would make the inspector silently blink out the
  // moment the selected row leaves the loaded list (a filter change, or a
  // tail-only row aging out) — the panel would vanish with no feedback. Instead
  // we keep the last-selected doc as a sticky fallback and, in render, prefer the
  // row's latest copy from the list when it's still there. No effect needed: the
  // displayed doc is derived, so it stays open (showing the cached copy) once the
  // row is gone, until the user picks another row.
  const [cachedDoc, setCachedDoc] = useState<LogDoc | null>(null);
  const selectedId = cachedDoc?._id ?? null;
  const onRowClick = useCallback(
    (id: string) => {
      const doc = items.find((d) => d._id === id);
      if (doc) setCachedDoc(doc);
    },
    [items],
  );
  const selectedDoc = useMemo<LogDoc | null>(() => {
    if (!selectedId) return null;
    return items.find((d) => d._id === selectedId) ?? cachedDoc;
  }, [items, selectedId, cachedDoc]);

  const onPivot = useCallback(
    (frag: PivotFragment) => editFilters(applyPivot(filters, frag)),
    [editFilters, filters],
  );

  // ---- app switcher (app scope lives in the URL filters) --------------------
  const eventsQuery = useEvents();
  const apps = useMemo(() => Object.keys(eventsQuery.data?.apps ?? {}), [eventsQuery.data]);

  // ---- group-by panel -------------------------------------------------------
  const [groupOpen, setGroupOpen] = useState(false);
  const facetDims = useMemo(() => {
    const base = ["app", "level", "event"];
    // Offer the configured user key as a convenient default ids dimension.
    const idDim = `ids.${viewCfg.userKeys[0] ?? "userEmail"}`;
    return Array.from(new Set([...base, idDim]));
  }, [viewCfg.userKeys]);
  const [groupBy, setGroupBy] = useState<string>("app");

  // ---- lenses + saved views -------------------------------------------------
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => loadSavedViews());
  const [activeLens, setActiveLens] = useState<string | undefined>(undefined);

  const onApplyLens = useCallback(
    (lens: Lens) => {
      setActiveLens(lens.id);
      pushFilters(lens.apply(filters, viewCfg));
      if (lens.groupBy) {
        setGroupBy(lens.groupBy);
        setGroupOpen(true);
      }
    },
    [pushFilters, filters, viewCfg],
  );

  const onApplySaved = useCallback(
    (view: SavedView) => {
      navigate({ to: "/", search: () => searchObjectFromString(view.params), replace: false });
    },
    [navigate],
  );

  const onSaveCurrent = useCallback(
    (name: string) => {
      const view: SavedView = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        params: filtersToParams(filters).toString(),
      };
      saveView(view);
      setSavedViews(loadSavedViews());
    },
    [filters],
  );

  const onDeleteSaved = useCallback((id: string) => {
    deleteView(id);
    setSavedViews(loadSavedViews());
  }, []);

  // ---- 401 banner -----------------------------------------------------------
  const err = logsQuery.error;
  const unauthorized = err instanceof ApiError && err.status === 401;
  const storageDown = err instanceof ApiError && err.status === 503;

  return (
    <div style={{ display: "flex", minHeight: 0, height: "100%" }}>
      <aside
        style={{
          flex: "0 0 220px",
          borderInlineEnd: "1px solid var(--tb-border)",
          background: "var(--tb-surface)",
          overflowY: "auto",
        }}
      >
        <LensRail
          active={activeLens}
          onApplyLens={onApplyLens}
          savedViews={savedViews}
          onApplySaved={onApplySaved}
          onSaveCurrent={onSaveCurrent}
          onDeleteSaved={onDeleteSaved}
        />
      </aside>

      <section style={{ flex: 1, minWidth: 0, padding: 16, display: "flex", flexDirection: "column", gap: 12, overflow: "auto" }}>
        {/* 401/503 surface from the logs query error. The Settings dialog that
            resolves a 401 lives in the shell, so the 401 action asks the shell to
            open it (via a 'timber:open-settings' event); the 503 action retries
            the logs query in place. */}
        {unauthorized ? <Banner kind="401" onAction={openSettings} /> : null}
        {storageDown ? <Banner kind="503" onAction={() => logsQuery.refetch()} /> : null}

        {/* Scope + find row */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <label style={{ ...sectionLabel, display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span>App</span>
            <AppSwitcher
              apps={apps}
              value={filters.app}
              onChange={(app) => editFilters({ ...filters, app })}
            />
          </label>
          <FindByBar
            app={filters.app}
            range={findRange}
            filters={filters}
            onAdd={(row) => editFilters(withId(filters, row))}
          />
          <button
            type="button"
            aria-pressed={groupOpen}
            onClick={() => setGroupOpen((v) => !v)}
            style={toggleBtn(groupOpen)}
          >
            Group by
          </button>
          <button
            type="button"
            aria-pressed={tailOn}
            onClick={toggleTail}
            style={toggleBtn(tailOn)}
          >
            {tailOn ? "Live tail: on" : "Live tail"}
          </button>
        </div>

        <FilterBar filters={filtersForBar} onChange={onFilterBarChange} />

        {groupOpen ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              padding: 12,
              borderRadius: 10,
              border: "1px solid var(--tb-border)",
              background: "var(--tb-surface)",
            }}
          >
            <label style={{ ...sectionLabel, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span>Dimension</span>
              <select
                aria-label="Group-by dimension"
                value={groupBy}
                onChange={(e) => setGroupBy(e.target.value)}
                style={{
                  padding: "5px 8px",
                  borderRadius: 6,
                  border: "1px solid var(--tb-border)",
                  background: "var(--tb-surface)",
                  color: "var(--tb-text)",
                }}
              >
                {facetDims.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <GroupByPanel
              by={groupBy}
              filters={filters}
              onPick={(value) => editFilters(applyGroupPick(filters, groupBy, value))}
            />
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 12, minHeight: 0, alignItems: "flex-start" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <ResultsTable
              items={items}
              onRowClick={onRowClick}
              selectedId={selectedId}
              onLoadMore={() => logsQuery.fetchNextPage()}
              hasMore={logsQuery.hasNextPage ?? false}
              loading={logsQuery.isLoading || logsQuery.isFetchingNextPage}
            />
          </div>
          {selectedDoc ? (
            <div style={{ flex: "0 0 480px", maxWidth: 480, minWidth: 0 }}>
              {/* key on the doc id so DetailPanel's local in-document search +
                  segment state reset when a different row is selected (otherwise a
                  leftover search term would highlight in the new document). */}
              <DetailPanel key={selectedDoc._id} doc={selectedDoc} onPivot={onPivot} />
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

/** Parse a saved view's serialized params back into a search object. */
function searchObjectFromString(params: string): SearchObject {
  const p = new URLSearchParams(params);
  return filtersToSearch(paramsToFilters(p));
}

function toggleBtn(active: boolean): React.CSSProperties {
  return {
    height: 32,
    padding: "0 12px",
    borderRadius: 6,
    border: "1px solid var(--tb-border)",
    background: active ? "var(--tb-acc)" : "var(--tb-surface)",
    color: active ? "#fff" : "var(--tb-text)",
    cursor: "pointer",
    fontSize: 13,
  };
}
