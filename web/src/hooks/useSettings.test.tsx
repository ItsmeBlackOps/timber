import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { server } from "../../test/msw-server";
import { useSettings } from "@/hooks/useSettings";
import { useLogs } from "@/hooks/useLogs";
import { DEFAULTS, saveSettings } from "@/lib/settings";
import type { Filters } from "@/lib/filters";

const STORAGE_KEY = "timber.settings";
const EMPTY_FILTERS: Filters = { levels: [], ids: [], data: [] };

function qcWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("useSettings (reactive store)", () => {
  it("returns the current settings snapshot", () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.tailIntervalMs).toBe(DEFAULTS.tailIntervalMs);
    expect(result.current.readKey).toBe("");
  });

  it("an in-tab save updates a consumer with no unrelated re-render", () => {
    let renders = 0;
    function Probe() {
      renders++;
      const s = useSettings();
      return <span data-testid="tail">{s.tailIntervalMs}</span>;
    }
    render(<Probe />);
    expect(screen.getByTestId("tail").textContent).toBe(String(DEFAULTS.tailIntervalMs));
    const before = renders;

    // No prop/parent change — the update must come purely from the store.
    act(() => {
      saveSettings({ tailIntervalMs: 9999 });
    });

    expect(screen.getByTestId("tail").textContent).toBe("9999");
    // Exactly one additional render, driven solely by the settings store.
    expect(renders).toBe(before + 1);
  });

  it("a cross-tab storage event re-enables a gated query", async () => {
    let calls = 0;
    server.use(
      http.get("/v1/logs", () => {
        calls++;
        return HttpResponse.json({ items: [], nextCursor: null });
      }),
    );

    const { result } = renderHook(() => useLogs(EMPTY_FILTERS), { wrapper: qcWrapper() });

    // No key yet → the query is gated off and never fetches.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(calls).toBe(0);

    // Another tab writes a read key; this tab learns via the native storage event.
    const next = JSON.stringify({ readKey: "r-cross-tab" });
    act(() => {
      localStorage.setItem(STORAGE_KEY, next);
      window.dispatchEvent(
        new StorageEvent("storage", { key: STORAGE_KEY, newValue: next }),
      );
    });

    await waitFor(() => expect(calls).toBeGreaterThan(0));
  });
});
