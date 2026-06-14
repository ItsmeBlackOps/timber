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
import { useEffect, useRef } from "react";
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

export function ResultsTable({
  items,
  onRowClick,
  selectedId,
  onLoadMore,
  hasMore,
  loading,
}: ResultsTableProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    // Deterministic viewport for SSR/tests (real height comes from layout too).
    initialRect: { width: 900, height: VIEWPORT_HEIGHT },
  });

  // Infinite scroll: observe the sentinel; load the next page when it appears.
  // Keep the latest callback/flags in a ref so the observer effect can stay
  // mounted (re-created only when the sentinel node changes).
  const loadMoreRef = useRef(onLoadMore);
  loadMoreRef.current = onLoadMore;
  const canLoadRef = useRef(false);
  canLoadRef.current = hasMore && !loading;

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && canLoadRef.current) {
          loadMoreRef.current();
        }
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
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
                onClick={() => onRowClick(doc._id)}
              />
            </div>
          );
        })}
      </div>

      {/* Infinite-scroll sentinel + page-load affordance. */}
      <div ref={sentinelRef} data-testid="load-more-sentinel" style={{ height: 1 }} />
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
