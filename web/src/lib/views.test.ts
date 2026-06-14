import type { Filters } from "@/lib/filters";
import type { ViewCfg } from "@/lib/views";
import {
  BUILTIN_LENSES,
  loadSavedViews,
  saveView,
  deleteView,
} from "@/lib/views";

const cfg: ViewCfg = { userKeys: ["userEmail", "userId"], slowMs: 300 };

function emptyFilters(): Filters {
  return { levels: [], ids: [], data: [] };
}

function lens(id: string) {
  const l = BUILTIN_LENSES.find((x) => x.id === id);
  if (!l) throw new Error(`lens ${id} not found`);
  return l;
}

describe("BUILTIN_LENSES catalog", () => {
  it("contains the six curated lenses in order", () => {
    expect(BUILTIN_LENSES.map((l) => l.id)).toEqual([
      "errors",
      "ai-usage",
      "by-user",
      "by-service",
      "slow-ops",
      "cron",
    ]);
  });

  it("every lens has a label and a non-empty icon string", () => {
    for (const l of BUILTIN_LENSES) {
      expect(l.label.length).toBeGreaterThan(0);
      expect(typeof l.icon).toBe("string");
      expect(l.icon.length).toBeGreaterThan(0);
    }
  });
});

describe("lens.apply", () => {
  it("errors → levels [warn, error]", () => {
    const out = lens("errors").apply(emptyFilters(), cfg);
    expect(out.levels).toEqual(["warn", "error"]);
  });

  it("ai-usage → event 'ai.'", () => {
    const out = lens("ai-usage").apply(emptyFilters(), cfg);
    expect(out.event).toBe("ai.");
  });

  it("cron → event 'cron.'", () => {
    const out = lens("cron").apply(emptyFilters(), cfg);
    expect(out.event).toBe("cron.");
  });

  it("slow-ops → data.latencyMs >= slowMs", () => {
    const out = lens("slow-ops").apply(emptyFilters(), cfg);
    expect(out.data).toContainEqual({
      path: "latencyMs",
      op: "gte",
      value: "300",
    });
  });

  it("slow-ops uses the configured slowMs threshold", () => {
    const out = lens("slow-ops").apply(emptyFilters(), {
      userKeys: ["userEmail"],
      slowMs: 1500,
    });
    expect(out.data).toContainEqual({
      path: "latencyMs",
      op: "gte",
      value: "1500",
    });
  });

  it("by-user / by-service do not constrain the filter body", () => {
    const base = emptyFilters();
    expect(lens("by-user").apply(base, cfg)).toEqual(base);
    expect(lens("by-service").apply(base, cfg)).toEqual(base);
  });

  it("preserves existing base filter fields (app, range)", () => {
    const base: Filters = {
      app: "billing",
      from: "2026-06-14T00:00:00.000Z",
      to: "2026-06-14T10:00:00.000Z",
      levels: [],
      ids: [],
      data: [],
    };
    const out = lens("errors").apply(base, cfg);
    expect(out.app).toBe("billing");
    expect(out.from).toBe(base.from);
    expect(out.to).toBe(base.to);
    expect(out.levels).toEqual(["warn", "error"]);
  });

  it("does not mutate the input base filters", () => {
    const base = emptyFilters();
    const snapshot = structuredClone(base);
    lens("slow-ops").apply(base, cfg);
    lens("errors").apply(base, cfg);
    expect(base).toEqual(snapshot);
  });
});

describe("lens.groupBy", () => {
  it("by-user groups by ids.<userKeys[0]>", () => {
    expect(lens("by-user").groupBy).toBe("ids.userEmail");
  });

  it("by-service groups by app", () => {
    expect(lens("by-service").groupBy).toBe("app");
  });

  it("non-grouping lenses have no groupBy", () => {
    expect(lens("errors").groupBy).toBeUndefined();
    expect(lens("ai-usage").groupBy).toBeUndefined();
    expect(lens("slow-ops").groupBy).toBeUndefined();
    expect(lens("cron").groupBy).toBeUndefined();
  });
});

describe("saved views CRUD", () => {
  beforeEach(() => localStorage.clear());

  it("loadSavedViews returns [] when empty", () => {
    expect(loadSavedViews()).toEqual([]);
  });

  it("saveView persists and loadSavedViews reads it back", () => {
    saveView({ id: "v1", name: "My errors", params: "level=error" });
    const views = loadSavedViews();
    expect(views).toHaveLength(1);
    expect(views[0]).toEqual({
      id: "v1",
      name: "My errors",
      params: "level=error",
    });
  });

  it("saveView with an existing id updates in place (no duplicate)", () => {
    saveView({ id: "v1", name: "First", params: "a=1" });
    saveView({ id: "v1", name: "Renamed", params: "a=2" });
    const views = loadSavedViews();
    expect(views).toHaveLength(1);
    expect(views[0].name).toBe("Renamed");
    expect(views[0].params).toBe("a=2");
  });

  it("saveView appends distinct ids preserving order", () => {
    saveView({ id: "v1", name: "One", params: "a=1" });
    saveView({ id: "v2", name: "Two", params: "b=2" });
    expect(loadSavedViews().map((v) => v.id)).toEqual(["v1", "v2"]);
  });

  it("deleteView removes by id", () => {
    saveView({ id: "v1", name: "One", params: "a=1" });
    saveView({ id: "v2", name: "Two", params: "b=2" });
    deleteView("v1");
    const views = loadSavedViews();
    expect(views.map((v) => v.id)).toEqual(["v2"]);
  });

  it("deleteView on a missing id is a no-op", () => {
    saveView({ id: "v1", name: "One", params: "a=1" });
    deleteView("nope");
    expect(loadSavedViews()).toHaveLength(1);
  });

  it("loadSavedViews tolerates corrupt storage", () => {
    localStorage.setItem("timber.savedViews", "{broken");
    expect(loadSavedViews()).toEqual([]);
  });
});
