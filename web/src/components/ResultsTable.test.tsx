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
    constructor(cb: IntersectionObserverCallback) {
      this.cb = cb;
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
});
