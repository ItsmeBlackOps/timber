// ResultsTable (Task F7) — the virtualized log list.
//
// Virtualized with @tanstack/react-virtual so a 10k-row page stays cheap: only
// the rows in (and near) the viewport mount. Infinite scroll is driven by an
// IntersectionObserver on a sentinel placed below the rows — when it scrolls
// into view and there's another page, we call onLoadMore (guarded so we never
// double-fire while a fetch is in flight).
//
// initialRect gives the virtualizer a viewport size without a real layout pass,
// which also makes it deterministic under jsdom in tests.
import { memo, useCallback, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import { LogRow } from "@/components/LogRow";
import type { LogDoc } from "@/lib/types";

export interface ResultsTableProps {
  items: LogDoc[];
  onRowClick: (id: string) => void;
  selectedId: string | null;
  onLoadMore: () => void;
  hasMore: boolean;
  loading: boolean;
}

const ROW_HEIGHT = 38;
const VIEWPORT_HEIGHT = 520;

function ResultsTableImpl({
  items,
  onRowClick,
  selectedId,
  onLoadMore,
  hasMore,
  loading,
}: ResultsTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Per-row onClick must be REFERENCE-STABLE across renders or it defeats the
  // React.memo on LogRow (a fresh `() => onRowClick(id)` per render would force
  // every visible row to re-render on each parent tick — e.g. the 2s live-tail
  // poll). Stash the latest onRowClick in a ref and hand each id a cached
  // closure that reads it, so the closures stay identity-stable while always
  // dispatching to the current callback.
  const onRowClickRef = useRef(onRowClick);
  onRowClickRef.current = onRowClick;
  const clickCacheRef = useRef<Map<string, () => void>>(new Map());
  const getRowClick = useCallback((id: string) => {
    const cache = clickCacheRef.current;
    let handler = cache.get(id);
    if (!handler) {
      handler = () => onRowClickRef.current(id);
      cache.set(id, handler);
    }
    return handler;
  }, []);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    // Deterministic viewport for SSR/tests (real height comes from layout too).
    initialRect: { width: 900, height: VIEWPORT_HEIGHT },
  });

  // Infinite scroll: observe the sentinel via a CALLBACK REF so the observer is
  // (re)attached whenever the sentinel node actually mounts. This is essential on
  // a cold load: the first render is the loading/empty placeholder, so the
  // sentinel doesn't exist yet — a mount-time useEffect would see a null node and
  // never re-run. The callback ref instead fires when the sentinel mounts (after
  // rows arrive). Latest callback/flags live in refs so the observer created at
  // mount always sees current props without re-subscribing; setSentinel is stable
  // (useCallback []) so it only runs when the node mounts/unmounts, not per render.
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;
  const canLoadRef = useRef(false);
  canLoadRef.current = hasMore && !loading;

  const observerRef = useRef<IntersectionObserver | null>(null);
  const setSentinel = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && canLoadRef.current) {
            loadMoreRef.current();
          }
        }
      },
      {
        // The sentinel lives inside the overflow:auto scroll container (its
        // parent), which can sit below the page fold — so intersection must be
        // computed against that container, not the document viewport, or
        // load-more never fires. rootMargin prefetches the next page just before
        // the user hits the very bottom.
        root: node.parentElement,
        rootMargin: "200px",
      },
    );
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  // First-page loading: dedicated status, no rows yet.
  if (loading && items.length === 0) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-busy="true"
        style={{
          display: "grid",
          placeItems: "center",
          height: 160,
          color: "var(--tb-mut)",
        }}
      >
        Loading events…
      </div>
    );
  }

  // Empty result set.
  if (!loading && items.length === 0) {
    return (
      <div
        style={{
          display: "grid",
          placeItems: "center",
          height: 160,
          color: "var(--tb-mut)",
          textAlign: "center",
        }}
      >
        No events match the current filters.
      </div>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={scrollRef}
      role="grid"
      aria-rowcount={items.length}
      style={{
        height: VIEWPORT_HEIGHT,
        overflow: "auto",
        border: "1px solid var(--tb-border)",
        borderRadius: 8,
        background: "var(--tb-surface)",
      }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualItems.map((vi) => {
          const doc = items[vi.index];
          return (
            <div
              key={doc._id}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <LogRow
                doc={doc}
                selected={doc._id === selectedId}
                onClick={getRowClick(doc._id)}
              />
            </div>
          );
        })}
      </div>

      {/* Infinite-scroll sentinel + page-load affordance. */}
      <div ref={setSentinel} data-testid="load-more-sentinel" style={{ height: 1 }} />
      {hasMore && loading ? (
        <div
          role="status"
          aria-live="polite"
          style={{ padding: "10px 0", textAlign: "center", color: "var(--tb-mut)" }}
        >
          Loading more…
        </div>
      ) : null}
    </div>
  );
}

// Memoized: ExploreRoute re-renders often (live-tail tick, facet churn). With a
// stable `items` reference the table — and its virtualizer — skips the whole
// reconcile. When `items` does change identity React.memo falls through to a
// normal render, so there's no correctness cost, only an upside.
export const ResultsTable = memo(ResultsTableImpl);
