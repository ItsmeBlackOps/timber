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
import { useCallback, useMemo, useRef, useState } from "react";
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
import type { Filters, IdFilter } from "@/lib/filters";
import { loadSettings } from "@/lib/settings";
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

  // View tunables for lenses (user identity keys + slow threshold).
  const settings = loadSettings();
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

  // ---- data -----------------------------------------------------------------
  const logsQuery = useLogs(filters);
  const logItems = logsQuery.items;

  // Live tail: poll page-1, prepend new rows, dedupe by _id (spec §8.2).
  const [tailOn, setTailOn] = useState(false);
  const tail = useLiveTail(filters, tailOn);
  // Accumulate tail-only rows (those whose _id isn't already in the page list)
  // across polls so they persist between refetches.
  const tailAccum = useRef<Map<string, LogDoc>>(new Map());
  if (tailOn) {
    const pageIds = new Set(logItems.map((d) => d._id));
    for (const doc of tail.items) {
      if (!pageIds.has(doc._id)) tailAccum.current.set(doc._id, doc);
    }
  }
  const items = useMemo<LogDoc[]>(() => {
    if (!tailOn || tailAccum.current.size === 0) return logItems;
    const pageIds = new Set(logItems.map((d) => d._id));
    const prepended = [...tailAccum.current.values()].filter((d) => !pageIds.has(d._id));
    return [...prepended, ...logItems];
  }, [tailOn, logItems, tail.items]);

  // Reset the prepend buffer whenever the tail is turned off so stale rows don't
  // reappear if it's re-enabled later.
  const toggleTail = useCallback(() => {
    setTailOn((on) => {
      if (on) tailAccum.current.clear();
      return !on;
    });
  }, []);

  // ---- selection / detail ---------------------------------------------------
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedDoc = useMemo(
    () => items.find((d) => d._id === selectedId) ?? null,
    [items, selectedId],
  );

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
        {/* 401/503 surface from the logs query error. The Settings trigger that
            resolves a 401 lives in the shell (F13), so no inline action here. */}
        {unauthorized ? <Banner kind="401" /> : null}
        {storageDown ? <Banner kind="503" /> : null}

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
            range={last24h()}
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

        <FilterBar filters={filters} onChange={editFilters} />

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
              onRowClick={setSelectedId}
              selectedId={selectedId}
              onLoadMore={() => logsQuery.fetchNextPage()}
              hasMore={logsQuery.hasNextPage ?? false}
              loading={logsQuery.isLoading || logsQuery.isFetchingNextPage}
            />
          </div>
          {selectedDoc ? (
            <div style={{ flex: "0 0 480px", maxWidth: 480, minWidth: 0 }}>
              <DetailPanel doc={selectedDoc} onPivot={onPivot} />
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
