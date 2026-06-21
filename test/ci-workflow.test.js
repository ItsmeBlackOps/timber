// Guard test for the CI pipeline definition (.github/workflows/ci.yml).
//
// Finding (ops-build): CI ran ZERO web/ checks — the entire Timber Console SPA
// (web/) was never built, type-checked, or unit-tested by the pipeline, so a
// broken `tsc -b`, a failing `vite build`, or a regressed vitest suite would all
// ship undetected on feat/timber-console. The server suite is the only thing that
// can mechanically enforce "CI covers the console", so this test parses the
// workflow YAML (no yaml dep — Timber is dependency-light, so we assert on the raw
// text) and fails if the web green-gate steps are absent.
//
// The green-gate is the plan's authoritative one (plans/2026-06-14-timber-console.md
// lines 344/351): `cd web && npm run typecheck && npm run test && npm run build`,
// preceded by an INDEPENDENT `npm ci` for the web workspace (root `npm ci` does not
// install web deps — there are no npm `workspaces`). `lint` is intentionally NOT a
// hard gate: it is absent from the plan's green-gate and the committed web sources
// carry pre-existing lint findings owned elsewhere; gating on it here would wedge CI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ciPath = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
const ci = readFileSync(ciPath, 'utf8');

// Collapse to a normalized, comment-stripped form so assertions are resilient to
// reformatting/quoting while still anchoring on the actual command tokens.
const lines = ci
  .split(/\r?\n/)
  .map((l) => l.replace(/#.*$/, '').trimEnd())
  .filter((l) => l.trim() !== '');
const text = lines.join('\n');

test('ci.yml still runs the server suite + bench smoke (no regression)', () => {
  assert.match(text, /npm test/, 'server `npm test` step missing');
  assert.match(text, /BENCH_SMOKE=1 node bench\/ingest-bench\.js/, 'bench smoke step missing');
  assert.match(text, /TIMBER_TEST_MONGODB_URI:/, 'Mongo service URI env for the server suite missing');
});

test('ci.yml installs the web workspace deps with its OWN npm ci', () => {
  // Root `npm ci` does not install web/ deps (no workspaces), so there must be a
  // web-scoped install. Accept either `cd web && npm ci` or a job-level
  // working-directory: web with `npm ci`.
  const hasCdInstall = /cd web\s*&&\s*npm ci\b/.test(text);
  const hasWorkdirInstall =
    /working-directory:\s*web\b/.test(text) && /^\s*-?\s*run:\s*npm ci\b/m.test(text);
  assert.ok(
    hasCdInstall || hasWorkdirInstall,
    'no web-scoped `npm ci` found — root npm ci does not install web/ deps',
  );
});

test('ci.yml runs the web green-gate: typecheck + test + build', () => {
  // Each command must run against the web workspace. Accept `cd web && npm run X`
  // or a `working-directory: web` block containing `npm run X`.
  const usesWorkdir = /working-directory:\s*web\b/.test(text);
  for (const script of ['typecheck', 'test', 'build']) {
    const cdForm = new RegExp(`cd web\\s*&&[^\\n]*npm run ${script}\\b`);
    const runForm = new RegExp(`npm run ${script}\\b`);
    const ok = cdForm.test(text) || (usesWorkdir && runForm.test(text));
    assert.ok(ok, `web \`npm run ${script}\` step missing from CI`);
  }
});

test('the web checks can actually run (web job/steps are wired, not just declared)', () => {
  // Sanity: the workflow must reference the web workspace somewhere beyond a bare
  // comment — either via `cd web` or `working-directory: web`.
  assert.match(text, /(cd web\b|working-directory:\s*web\b)/, 'workflow never enters web/');
});
