// Guards the docs content tree against the `react-refresh/only-export-components`
// lint error (the finding: 9 such errors across content/docs/_ui.tsx + the 8 page
// modules). These modules deliberately co-locate static doc DATA (the DocPage /
// Recipe constants) with their stateless presentational renderers — Fast Refresh
// of static content is a non-goal — so the rule is scoped off for src/content/**
// in eslint.config.js. This test asserts that exemption keeps holding: lint the
// content tree through the real ESLint config and require zero occurrences of
// the rule. (Reproduces the finding; fails before the eslint.config.js fix.)
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const RULE = "react-refresh/only-export-components";

describe("docs content tree: react-refresh hygiene", () => {
  it(`reports zero \`${RULE}\` errors under src/content/**`, async () => {
    // vitest runs with cwd = web/, where eslint.config.js lives.
    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles(["src/content/**/*.{ts,tsx}"]);

    const offenders = results.flatMap((r) =>
      r.messages
        .filter((m) => m.ruleId === RULE)
        .map((m) => `${r.filePath}:${m.line}:${m.column}`),
    );

    expect(offenders, `unexpected ${RULE} errors:\n${offenders.join("\n")}`).toEqual([]);
    // Booting the full type-aware ESLint pipeline once takes ~25s; give it room.
  }, 60_000);
});
