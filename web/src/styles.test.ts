// Accessibility contract for global focus-visible styling (WCAG 2.4.7 Focus Visible).
//
// The console heavily restyles native controls (borderless JsonTree toggle buttons,
// the ClampedString "show more" link-button, DetailPanel IdChip/SegButton with an
// accent-filled active state, MiniButton, LensRail/GroupByPanel bar buttons). With
// no explicit :focus-visible treatment, keyboard focus depends on the UA default
// outline, which is easily lost against these custom backgrounds. styles.css must
// declare a project-wide, token-driven focus ring.
//
/// <reference types="node" />
// jsdom does not process @import'ed Tailwind or compute styles from external
// stylesheets, so this is verified as a static contract on the stylesheet source.
//
// The source is read straight from disk. Vite import tricks do NOT work here: the
// @tailwindcss/vite plugin claims every `.css` module, so `?raw` and `?inline`
// both yield an empty string — assertions would then pass/fail on nothing. Node's
// fs is also not in tsconfig.app's `types` array, hence the file-local
// `/// <reference types="node" />` above (kept local so the shared tsconfig's
// no-node-in-app-code boundary is untouched). Resolving from the Vitest cwd (the
// web/ project root) gives the real source so the focus contract is enforced.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

/** Strip CSS comments so block-matching ignores commentary. */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Return the declaration body of the first rule whose selector list contains `selector`. */
function ruleBody(selector: string): string | null {
  // Match "<prelude> { <body> }" then keep only the selector list — the text after
  // the last statement terminator (`;` from @import / `}` from a prior rule).
  const re = /([^{}]*)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const prelude = m[1].replace(/[\s\S]*[;}]/, '')
    const selectors = prelude.split(',').map((s) => s.trim())
    if (selectors.includes(selector)) return m[2]
  }
  return null
}

describe('styles.css global focus-visible contract', () => {
  it('declares a project-wide :focus-visible rule', () => {
    expect(code).toMatch(/:focus-visible/)
  })

  it('gives :focus-visible a visible outline using the accent token', () => {
    const body = ruleBody('*:focus-visible')
    expect(body, 'expected a `*:focus-visible { … }` rule in styles.css').not.toBeNull()
    const decls = (body ?? '').toLowerCase()
    // A real, non-removed outline (not outline:none / outline:0).
    expect(decls).toMatch(/outline\s*:/)
    expect(decls).not.toMatch(/outline\s*:\s*(none|0)\b/)
    // Ring color comes from the theme accent token so it works in both themes.
    expect(decls).toMatch(/outline[^;]*var\(\s*--tb-acc\s*\)/)
  })

  it('offsets the focus ring so it stays visible against custom backgrounds', () => {
    const body = ruleBody('*:focus-visible') ?? ''
    expect(body.toLowerCase()).toMatch(/outline-offset\s*:/)
  })

  it('never removes the focus indicator without restoring it (no unguarded outline:none)', () => {
    // The only acceptable `outline: none` is the keyboard-only guard
    // `*:focus:not(:focus-visible)`, which suppresses the ring for pointer focus
    // while :focus-visible still draws it. Any other stripped outline would leave a
    // focusable control with no indicator.
    const lower = code.toLowerCase()
    const re = /([^{}]*)\{([^{}]*)\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(lower)) !== null) {
      const body = m[2]
      if (!/outline\s*:\s*(none|0)\b/.test(body)) continue
      const prelude = m[1].replace(/[\s\S]*[;}]/, '').trim()
      expect(
        prelude.includes(':focus:not(:focus-visible)'),
        `stripped outline in a non-keyboard-guarded rule: "${prelude}"`,
      ).toBe(true)
    }
  })
})
