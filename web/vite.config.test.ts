// Build chunking contract for the production bundle (ops-build finding).
//
// Route-level code-splitting (router.tsx) already pulls the heavy, route-only
// payloads — recharts (Stats) and the in-app docs prose (Docs) — into their own
// lazy chunks fetched only when visited, so neither lands on the Explore ("/")
// first paint. What that split does NOT do is separate the framework vendor
// (React + ReactDOM + the TanStack Router/Query/Virtual runtime) from the app's
// own source: both are co-bundled in the entry chunk, so every app-code change
// busts the cache for ~120 kB gzip of rarely-changing vendor code.
//
// vite.config.ts therefore declares a `build.rolldownOptions.output.codeSplitting`
// group that captures node_modules into a long-lived `vendor` chunk. This is the
// Rolldown-native, non-deprecated chunking API for Vite 8 (the Rollup-style
// `output.manualChunks` function is deprecated in favour of `codeSplitting`).
//
// This is verified as a STATIC contract on the config source read from disk —
// the same approach styles.test.ts uses — rather than by importing the config
// module (its top-level `fileURLToPath(new URL('./src', import.meta.url))` throws
// outside a file: URL context) or running a full `vite build` (slow). The end-to-
// end proof that the split actually produces a vendor chunk with no recharts in
// the entry is exercised by the build step itself; here we lock the config.
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Resolve from the Vitest cwd (the web/ project root) to read the real config.
const src = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8')

/** Strip line + block comments so matching ignores the commentary above. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('vite.config production chunking', () => {
  it('configures Rolldown code-splitting on the build output (not the deprecated manualChunks)', () => {
    // The non-deprecated Vite 8 / Rolldown chunking API: build.rolldownOptions
    // .output.codeSplitting. We assert the path appears in the config source.
    expect(code).toMatch(/build\s*:/)
    expect(code).toMatch(/rolldownOptions\s*:/)
    expect(code).toMatch(/output\s*:/)
    expect(code).toMatch(/codeSplitting\s*:/)
    expect(code).toMatch(/groups\s*:/)
    // The Rollup-compat function form is deprecated in Rolldown — don't use it.
    expect(code).not.toMatch(/manualChunks/)
  })

  it('declares a vendor group that captures node_modules into its own chunk', () => {
    // A group named 'vendor' (the chunk / [name] placeholder) testing node_modules.
    expect(code).toMatch(/name\s*:\s*['"]vendor['"]/)
    // The group must scope to node_modules so app source is never swept in.
    expect(code).toMatch(/node_modules/)
  })

  it('isolates recharts (heavy, /stats-only) into its own non-vendor chunk', () => {
    // recharts is ~107 kB gzip and only used by the lazy Stats route. Even though
    // route-splitting already keeps it off "/", giving it a dedicated group keeps
    // it from being merged with the framework vendor and makes the split explicit.
    expect(code).toMatch(/recharts/)
    expect(code).toMatch(/name\s*:\s*['"](recharts|charts)['"]/)
  })

  it('uses a Windows-safe path-separator class after node_modules (not a bare "/")', () => {
    // Rolldown's documented guidance: match path separators with [\\/] so the
    // regex works on Windows too (`/node_modules[\\/]react/`, not
    // `/node_modules/react/`). Reject any `node_modules/<segment>` written with a
    // bare forward slash in the config source.
    expect(
      code,
      'node_modules followed by a bare "/" — use the [\\/] separator class for Windows',
    ).not.toMatch(/node_modules\/[A-Za-z@]/)
  })
})
