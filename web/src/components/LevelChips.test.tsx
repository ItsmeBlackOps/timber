/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LevelChips } from "@/components/LevelChips";
import type { Level } from "@/lib/types";

// --- WCAG 2.x contrast helpers (used by the token-contrast suite below) ------
function srgbToLin(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").trim();
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}
function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}
function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a) + 0.05;
  const lb = relativeLuminance(b) + 0.05;
  return Math.max(la, lb) / Math.min(la, lb);
}
/** CSS color-mix(in srgb, fg pct%, bg) — straight sRGB channel mix. */
function colorMixSrgb(fg: string, bg: string, pct: number): string {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  const m = f.map((v, i) => Math.round(v * pct + b[i] * (1 - pct)));
  return "#" + m.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/** Pull the light-theme (`:root { … }`) level token hexes out of tokens.css. */
function readLightLevelTokens(): {
  bg: string;
  surface: string;
  levels: Record<Level, string>;
} {
  // vitest runs with cwd = web/, so resolve the token file from there (jsdom's
  // import.meta.url is not a usable file:// URL under the transform).
  const cssPath = resolve(process.cwd(), "src/theme/tokens.css");
  const css = readFileSync(cssPath, "utf8");
  // The first `:root { … }` block holds the light defaults; the dark block is
  // the `:root[data-theme="dark"]` selector that follows. Bound the slice by
  // those two selectors (not a bare `[data-theme`, which also appears in the
  // header comment).
  const lightStart = css.indexOf(":root");
  const darkStart = css.indexOf(":root[data-theme");
  const root = css.slice(lightStart, darkStart === -1 ? undefined : darkStart);
  const grab = (name: string): string => {
    const m = root.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`));
    if (!m) throw new Error(`token --${name} not found in tokens.css :root`);
    return m[1];
  };
  return {
    bg: grab("tb-bg"),
    surface: grab("tb-surface"),
    levels: {
      debug: grab("tb-debug"),
      info: grab("tb-info"),
      warn: grab("tb-warn"),
      error: grab("tb-error"),
    },
  };
}

describe("LevelChips", () => {
  it("renders a chip per level", () => {
    render(<LevelChips value={[]} onChange={() => {}} />);
    for (const lvl of ["debug", "info", "warn", "error"]) {
      expect(
        screen.getByRole("button", { name: new RegExp(lvl, "i") }),
      ).toBeInTheDocument();
    }
  });

  it("marks selected levels as pressed and unselected as not pressed", () => {
    render(<LevelChips value={["error", "warn"]} onChange={() => {}} />);
    expect(
      screen.getByRole("button", { name: /error/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /warn/i }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /info/i }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: /debug/i }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("adds a level when an unselected chip is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LevelChips value={["error"]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /warn/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as Level[];
    expect(new Set(next)).toEqual(new Set<Level>(["error", "warn"]));
  });

  it("removes a level when a selected chip is clicked", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LevelChips value={["error", "warn"]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: /error/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual(["warn"]);
  });

  // --- a11y: WCAG AA contrast (finding web-a11y) -------------------------------
  // In light theme the per-level tokens (warn/error/debug/info) over the 16%
  // tint background fall below 4.5:1, so a *selected* chip must NOT paint its
  // label in the per-level color. The label uses the high-contrast --tb-text
  // token; the level color is carried by the border so severity stays encoded.
  describe("selected-chip contrast (WCAG AA)", () => {
    it.each<[Level, string]>([
      ["debug", "--tb-debug"],
      ["info", "--tb-info"],
      ["warn", "--tb-warn"],
      ["error", "--tb-error"],
    ])("paints the selected %s label with --tb-text, not the level token", (level) => {
      render(<LevelChips value={[level]} onChange={() => {}} />);
      const chip = screen.getByRole("button", { name: new RegExp(level, "i") });
      const style = chip.getAttribute("style") ?? "";
      // The text color must be the high-contrast token, never the level var.
      expect(style).toMatch(/color:\s*var\(--tb-text\)/);
    });

    it.each<[Level, string]>([
      ["debug", "--tb-debug"],
      ["info", "--tb-info"],
      ["warn", "--tb-warn"],
      ["error", "--tb-error"],
    ])("keeps the level color on the selected %s chip border (severity cue)", (level, token) => {
      render(<LevelChips value={[level]} onChange={() => {}} />);
      const chip = screen.getByRole("button", { name: new RegExp(level, "i") });
      const style = chip.getAttribute("style") ?? "";
      expect(style).toMatch(new RegExp(`border[^;]*var\\(${token}\\)`));
    });

    it("unselected chips keep the muted text token", () => {
      render(<LevelChips value={[]} onChange={() => {}} />);
      const chip = screen.getByRole("button", { name: /warn/i });
      const style = chip.getAttribute("style") ?? "";
      expect(style).toMatch(/color:\s*var\(--tb-mut\)/);
    });
  });

  // --- a11y: the underlying light-theme level TOKENS must clear AA ------------
  // Root cause of the finding: in light mode the per-level tokens were too light
  // to use as text on white/the surface (the LogRow chip paints the level color
  // as 11px text over the surface) and even as the selected-chip border severity
  // cue over the 16% tint. The chip components can route *label* text through
  // --tb-text, but the only fix for the LogRow text chip + the border cue is to
  // darken the tokens themselves. Lock them at >=4.5:1 so they can never regress
  // back below AA. (Dark theme already passes comfortably; this guards light.)
  describe("light-theme level token contrast (WCAG AA, 4.5:1)", () => {
    const { surface, levels } = readLightLevelTokens();

    it.each<[Level]>([["debug"], ["info"], ["warn"], ["error"]])(
      "%s token clears 4.5:1 as text on the surface (LogRow chip)",
      (level) => {
        const ratio = contrastRatio(levels[level], surface);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      },
    );

    it.each<[Level]>([["debug"], ["info"], ["warn"], ["error"]])(
      "%s token clears 4.5:1 on its own 16-percent tint (selected LevelChip)",
      (level) => {
        const tint = colorMixSrgb(levels[level], surface, 0.16);
        const ratio = contrastRatio(levels[level], tint);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      },
    );
  });
});
