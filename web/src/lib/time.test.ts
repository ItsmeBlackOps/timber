import { PRESETS, presetRange, fmtRelative, fmtAbsolute } from "@/lib/time";

describe("PRESETS", () => {
  it("exposes 15m,1h,6h,24h,7d in order with correct ms", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["15m", "1h", "6h", "24h", "7d"]);
    const byId = Object.fromEntries(PRESETS.map((p) => [p.id, p.ms]));
    expect(byId["15m"]).toBe(15 * 60_000);
    expect(byId["1h"]).toBe(60 * 60_000);
    expect(byId["6h"]).toBe(6 * 60 * 60_000);
    expect(byId["24h"]).toBe(24 * 60 * 60_000);
    expect(byId["7d"]).toBe(7 * 24 * 60 * 60_000);
  });

  it("every preset has a non-empty label", () => {
    for (const p of PRESETS) expect(p.label.length).toBeGreaterThan(0);
  });
});

describe("presetRange", () => {
  it("returns ISO {from,to} with to=now and from=now-ms for '1h'", () => {
    const now = new Date("2026-06-14T10:00:00.000Z");
    const { from, to } = presetRange("1h", now);
    expect(to).toBe("2026-06-14T10:00:00.000Z");
    expect(from).toBe("2026-06-14T09:00:00.000Z");
  });

  it("computes '15m' window correctly", () => {
    const now = new Date("2026-06-14T10:00:00.000Z");
    expect(presetRange("15m", now).from).toBe("2026-06-14T09:45:00.000Z");
  });

  it("computes '7d' window correctly", () => {
    const now = new Date("2026-06-14T00:00:00.000Z");
    expect(presetRange("7d", now).from).toBe("2026-06-07T00:00:00.000Z");
  });

  it("throws on unknown preset id", () => {
    expect(() => presetRange("nope", new Date())).toThrow();
  });
});

describe("fmtRelative", () => {
  const now = new Date("2026-06-14T10:00:00.000Z");

  it("formats seconds", () => {
    expect(fmtRelative("2026-06-14T09:59:48.000Z", now)).toBe("12s ago");
  });

  it("formats sub-second as 0s ago", () => {
    expect(fmtRelative("2026-06-14T09:59:59.500Z", now)).toBe("0s ago");
  });

  it("formats minutes (floored)", () => {
    expect(fmtRelative("2026-06-14T09:57:00.000Z", now)).toBe("3m ago");
    expect(fmtRelative("2026-06-14T09:57:30.000Z", now)).toBe("2m ago");
  });

  it("formats hours (floored)", () => {
    expect(fmtRelative("2026-06-14T05:00:00.000Z", now)).toBe("5h ago");
  });

  it("formats days (floored)", () => {
    expect(fmtRelative("2026-06-11T10:00:00.000Z", now)).toBe("3d ago");
  });

  it("handles future timestamps as 0s ago", () => {
    expect(fmtRelative("2026-06-14T10:00:05.000Z", now)).toBe("0s ago");
  });
});

describe("fmtAbsolute", () => {
  it("formats as local YYYY-MM-DD HH:mm:ss", () => {
    const iso = "2026-06-14T10:42:09.000Z";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    const expected =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    expect(fmtAbsolute(iso)).toBe(expected);
  });

  it("matches the YYYY-MM-DD HH:mm:ss shape", () => {
    expect(fmtAbsolute("2026-01-02T03:04:05.000Z")).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
  });
});
