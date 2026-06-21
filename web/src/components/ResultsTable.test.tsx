import { memo } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResultsTable } from "@/components/ResultsTable";
import type { LogDoc } from "@/lib/types";

// ---- IntersectionObserver mock -------------------------------------------
// Capture observer instances so a test can synthesize the sentinel coming into
// view. Each instance records what it observes and exposes a trigger().
interface FakeIO {
  cb: IntersectionObserverCallback;
  elements: Element[];
  root: Element | Document | null;
  trigger: (isIntersecting: boolean) => void;
  disconnect: () => void;
  observe: (el: Element) => void;
  unobserve: (el: Element) => void;
}

let observers: FakeIO[] = [];

function installIntersectionObserver() {
  observers = [];
  class MockIO {
    cb: IntersectionObserverCallback;
    elements: Element[] = [];
    root: Element | Document | null;
    constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      this.cb = cb;
      this.root = (options?.root as Element | Document | null) ?? null;
      const self = this as unknown as FakeIO;
      self.trigger = (isIntersecting: boolean) => {
        this.cb(
          this.elements.map(
            (el) =>
              ({ isIntersecting, target: el, intersectionRatio: isIntersecting ? 1 : 0 }) as
                IntersectionObserverEntry,
          ),
          this as unknown as IntersectionObserver,
        );
      };
      observers.push(self);
    }
    observe(el: Element) {
      this.elements.push(el);
    }
    unobserve(el: Element) {
      this.elements = this.elements.filter((e) => e !== el);
    }
    disconnect() {
      this.elements = [];
    }
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", MockIO as unknown as typeof IntersectionObserver);
}

// Render-counting mock of LogRow, wrapped in React.memo so it re-renders ONLY
// when its props change by reference. This lets a test prove ResultsTable feeds
// each row reference-stable props (notably a stable per-row onClick): with a
// stable onClick the memoized row skips re-render when the parent re-renders
// with the same `items` reference; with a fresh inline `() => onRowClick(id)`
// closure per render it would re-render every time, defeating the memo.
const rowRenders = new Map<string, number>();
vi.mock("@/components/LogRow", () => ({
  LogRow: memo(function MockLogRow({
    doc,
    selected,
    onClick,
  }: {
    doc: LogDoc;
    selected: boolean;
    onClick: () => void;
  }) {
    rowRenders.set(doc._id, (rowRenders.get(doc._id) ?? 0) + 1);
    return (
      <div role="row" aria-selected={selected} onClick={onClick}>
        <span>{doc.event}</span>
        <span>{doc.message}</span>
      </div>
    );
  }),
}));

function makeItems(n: number): LogDoc[] {
  return Array.from({ length: n }, (_, i) => ({
    _id: `id-${i}`,
    app: "svc",
    env: "prod",
    event: `evt.${i}`,
    level: "info" as const,
    ts: "2026-06-14T05:00:00.000Z",
    message: `message ${i}`,
    ids: {},
    data: {},
    receivedAt: "2026-06-14T05:00:00.000Z",
    expiresAt: "2026-07-14T05:00:00.000Z",
  }));
}

// @tanstack/react-virtual measures the scroll element via offsetWidth/Height,
// which jsdom always reports as 0 (no layout). Feed real dimensions so the
// virtualizer produces a non-empty visible range.
function installLayout() {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return 520;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 900;
    },
  });
}

function uninstallLayout() {
  // @ts-expect-error remove the test override
  delete HTMLElement.prototype.offsetHeight;
  // @ts-expect-error remove the test override
  delete HTMLElement.prototype.offsetWidth;
}

beforeEach(() => {
  installIntersectionObserver();
  installLayout();
});

afterEach(() => {
  vi.unstubAllGlobals();
  uninstallLayout();
});

function noop() {}

describe("ResultsTable", () => {
  it("renders rows for the items (virtualized container present)", () => {
    render(
      <ResultsTable
        items={makeItems(5)}
        onRowClick={noop}
        selectedId={null}
        onLoadMore={noop}
        hasMore={false}
        loading={false}
      />,
    );
    // At least the first few rows are present.
    expect(screen.getByText("evt.0")).toBeInTheDocument();
    expect(screen.getByText("message 0")).toBeInTheDocument();
    // rows use role="row".
    expect(screen.getAllByRole("row").length).toBeGreaterThan(0);
  });

  it("marks the selected row by id", () => {
    render(
      <ResultsTable
        items={makeItems(5)}
        onRowClick={noop}
        selectedId="id-2"
        onLoadMore={noop}
        hasMore={false}
        loading={false}
      />,
    );
    const selected = screen
      .getAllByRole("row")
      .filter((r) => r.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent("evt.2");
  });

  it("calls onRowClick with the row's id when clicked", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <ResultsTable
        items={makeItems(5)}
        onRowClick={onRowClick}
        selectedId={null}
        onLoadMore={noop}
        hasMore={false}
        loading={false}
      />,
    );
    await user.click(screen.getByText("evt.1"));
    expect(onRowClick).toHaveBeenCalledWith("id-1");
  });

  it("calls onLoadMore when the sentinel intersects and hasMore", () => {
    const onLoadMore = vi.fn();
    render(
      <ResultsTable
        items={makeItems(5)}
        onRowClick={noop}
        selectedId={null}
        onLoadMore={onLoadMore}
        hasMore
        loading={false}
      />,
    );
    // A sentinel is observed.
    expect(observers.length).toBeGreaterThan(0);
    // Simulate it scrolling into view.
    observers.forEach((o) => o.trigger(true));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onLoadMore when hasMore is false", () => {
    const onLoadMore = vi.fn();
    render(
      <ResultsTable
        items={makeItems(5)}
        onRowClick={noop}
        selectedId={null}
        onLoadMore={onLoadMore}
        hasMore={false}
        loading={false}
      />,
    );
    observers.forEach((o) => o.trigger(true));
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("does NOT call onLoadMore again while already loading", () => {
    const onLoadMore = vi.fn();
    render(
      <ResultsTable
        items={makeItems(5)}
        onRowClick={noop}
        selectedId={null}
        onLoadMore={onLoadMore}
        hasMore
        loading
      />,
    );
    observers.forEach((o) => o.trigger(true));
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("shows an empty state when there are no items and not loading", () => {
    render(
      <ResultsTable
        items={[]}
        onRowClick={noop}
        selectedId={null}
        onLoadMore={noop}
        hasMore={false}
        loading={false}
      />,
    );
    expect(screen.getByText(/no events|no results|nothing/i)).toBeInTheDocument();
  });

  it("shows a loading indicator when loading the first page", () => {
    render(
      <ResultsTable
        items={[]}
        onRowClick={noop}
        selectedId={null}
        onLoadMore={noop}
        hasMore={false}
        loading
      />,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("observes the sentinel after a cold load (loading→items) and fires onLoadMore", () => {
    const onLoadMore = vi.fn();
    // Cold load: the first paint is the loading branch, so the sentinel is not
    // in the DOM yet and nothing should be observed.
    const { rerender } = render(
      <ResultsTable
        items={[]}
        onRowClick={noop}
        selectedId={null}
        onLoadMore={onLoadMore}
        hasMore
        loading
      />,
    );
    expect(observers.length).toBe(0);

    // Rows arrive: the sentinel now mounts and MUST become observed.
    rerender(
      <ResultsTable
        items={makeItems(5)}
        onRowClick={noop}
        selectedId={null}
        onLoadMore={onLoadMore}
        hasMore
        loading={false}
      />,
    );
    expect(observers.length).toBeGreaterThan(0);

    observers.forEach((o) => o.trigger(true));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it("roots the observer at the scroll container (so a sentinel below the page fold still triggers)", () => {
    render(
      <ResultsTable
        items={makeItems(5)}
        onRowClick={noop}
        selectedId={null}
        onLoadMore={noop}
        hasMore
        loading={false}
      />,
    );
    expect(observers.length).toBeGreaterThan(0);
    const root = observers[0].root;
    // The sentinel lives inside an overflow:auto container that can extend below
    // the viewport; intersection must be computed against that container, not the
    // document viewport, or load-more never fires.
    expect(root).not.toBeNull();
    expect((root as Element).getAttribute("role")).toBe("grid");
  });

  // --- Re-render hygiene (perf finding) ------------------------------------
  // ExploreRoute re-renders frequently (the 2s live-tail tick, facet churn).
  // Each such render hands ResultsTable a fresh inline `onLoadMore` closure
  // (explore.tsx) while the table's rows are unchanged. ResultsTable must be
  // memoized AND must feed each row reference-stable props so the (memoized)
  // rows don't re-render on every unrelated parent tick.

  it("is wrapped in React.memo so identical props skip a re-render", () => {
    expect(
      (ResultsTable as unknown as { $$typeof?: symbol }).$$typeof,
    ).toBe(Symbol.for("react.memo"));
  });

  it("does not re-render rows when the parent re-renders with the same items but a new onLoadMore", () => {
    rowRenders.clear();
    const items = makeItems(5);
    const { rerender } = render(
      <ResultsTable
        items={items}
        onRowClick={noop}
        selectedId={null}
        onLoadMore={() => {}}
        hasMore
        loading={false}
      />,
    );
    const initial = new Map(rowRenders);
    expect(initial.size).toBeGreaterThan(0); // some rows mounted

    // Parent re-renders: SAME items reference, but a brand-new onLoadMore
    // closure each time (exactly what `onLoadMore={() => fetchNextPage()}` does).
    rerender(
      <ResultsTable
        items={items}
        onRowClick={noop}
        selectedId={null}
        onLoadMore={() => {}}
        hasMore
        loading={false}
      />,
    );

    // Every row that was already mounted must NOT have re-rendered: the per-row
    // onClick (and doc/selected) stayed reference-stable, so React.memo on the
    // row short-circuits. A fresh `() => onRowClick(doc._id)` per render would
    // bump every count here.
    for (const [id, count] of initial) {
      expect(rowRenders.get(id)).toBe(count);
    }
  });

  it("re-renders only the row whose selection changed", () => {
    rowRenders.clear();
    const items = makeItems(5);
    const { rerender } = render(
      <ResultsTable
        items={items}
        onRowClick={noop}
        selectedId={null}
        onLoadMore={() => {}}
        hasMore={false}
        loading={false}
      />,
    );
    const initial = new Map(rowRenders);

    // Select id-2: only that row's `selected` prop flips.
    rerender(
      <ResultsTable
        items={items}
        onRowClick={noop}
        selectedId="id-2"
        onLoadMore={() => {}}
        hasMore={false}
        loading={false}
      />,
    );

    // id-2 re-renders (selected true); the rest stay put.
    expect(rowRenders.get("id-2")).toBe((initial.get("id-2") ?? 0) + 1);
    for (const [id, count] of initial) {
      if (id === "id-2") continue;
      expect(rowRenders.get(id)).toBe(count);
    }
  });
});
