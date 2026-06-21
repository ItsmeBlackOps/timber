// Regression guard for the lint gate (finding: `npm run lint` was red — exit 1,
// errors across committed files). Root cause, per the finding's own evidence:
// eslint.config.js extends `reactHooks.configs.flat.recommended` from
// eslint-plugin-react-hooks v7, whose `recommended` preset newly bundles the
// React COMPILER lint suite (set-state-in-effect / refs / immutability / purity
// / static-components / use-memo / set-state-in-render / …) plus the
// react-refresh/only-export-components Fast-Refresh rule — all as ERRORS. This
// project does not enable React Compiler in its Vite build (@vitejs/plugin-react,
// no babel-plugin-react-compiler) and the documented quality gate is
// typecheck + test + build, so eslint.config.js demotes that whole family to
// WARNINGS (kept as forward-looking signal; never gate-blocking).
//
// These two tests boot the REAL ESLint config (the same one `npm run lint`
// uses) over the src tree and assert that the demoted family produces ZERO
// ERROR-severity messages. They fail before the eslint.config.js fix and pass
// after — independent of unrelated standard-rule lint churn elsewhere in src,
// which is owned by other code (this guard is scoped to the rules this config
// governs).
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// The react-refresh + React-Compiler (react-hooks v7) rule family that
// eslint.config.js deliberately keeps as warnings, never errors.
const DEMOTED_RULES = new Set<string>([
  "react-refresh/only-export-components",
  "react-hooks/set-state-in-effect",
  "react-hooks/set-state-in-render",
  "react-hooks/refs",
  "react-hooks/immutability",
  "react-hooks/purity",
  "react-hooks/globals",
  "react-hooks/static-components",
  "react-hooks/use-memo",
  "react-hooks/preserve-manual-memoization",
  "react-hooks/error-boundaries",
  "react-hooks/incompatible-library",
]);

describe("lint gate: eslint.config.js", () => {
  // Lint the whole src tree once through the real config; share across tests.
  async function lintSrc() {
    // vitest runs with cwd = web/, where eslint.config.js lives.
    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles(["src/**/*.{ts,tsx}"]);
    expect(results.length).toBeGreaterThan(0); // glob actually matched files
    return results;
  }

  it("emits no ERROR-severity react-refresh / React-Compiler messages (they are warnings)", async () => {
    const results = await lintSrc();
    const offenders = results.flatMap((r) =>
      r.messages
        .filter((m) => m.severity === 2 && m.ruleId !== null && DEMOTED_RULES.has(m.ruleId))
        .map((m) => `${r.filePath}:${m.line}:${m.column} ${m.ruleId}`),
    );
    expect(
      offenders,
      `these rules must be warnings, not errors:\n${offenders.join("\n")}`,
    ).toEqual([]);
  }, 90_000);

  it("still surfaces those rules as warnings somewhere (the rule family stays active, not disabled)", async () => {
    // Guard against an over-broad fix that turns the rules OFF (which would hide
    // genuine future regressions) instead of demoting them to `warn`. At least
    // one such warning exists in the current tree (e.g. ResultsTable's
    // useVirtualizer -> react-hooks/incompatible-library, or a set-state-in-effect
    // in __root/SettingsDialog). If the codebase is ever fully RC-clean this can
    // be relaxed, but today it documents that the family is on-as-warn.
    const results = await lintSrc();
    const warned = results.some((r) =>
      r.messages.some(
        (m) => m.severity === 1 && m.ruleId !== null && DEMOTED_RULES.has(m.ruleId),
      ),
    );
    expect(warned).toBe(true);
  }, 90_000);
});
