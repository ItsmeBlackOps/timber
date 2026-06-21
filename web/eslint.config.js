import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// eslint-plugin-react-hooks v7's `recommended` preset newly bundles the React
// COMPILER lint suite (set-state-in-effect, refs, immutability, purity,
// static-components, use-memo, preserve-manual-memoization, set-state-in-render,
// memoized-effect-dependencies, …) — all at `error`. Those rules check for
// React-Compiler *compilation-readiness*. This project does NOT enable React
// Compiler in its Vite build (@vitejs/plugin-react with no
// babel-plugin-react-compiler installed), and the documented quality gate
// (plan/spec) is typecheck + test + build, never these RC-readiness lints. They
// were pulled in inadvertently when the plugin jumped to v7. We keep them ON as
// WARNINGS — useful forward-looking signal if the project ever adopts the
// compiler — but they must not break the lint gate. The classic, load-bearing
// hook rules keep their upstream severities (rules-of-hooks = error,
// exhaustive-deps = warn) and are deliberately left out of this list.
const REACT_COMPILER_RULES_AS_WARN = {
  'react-hooks/set-state-in-effect': 'warn',
  'react-hooks/set-state-in-render': 'warn',
  'react-hooks/refs': 'warn',
  'react-hooks/immutability': 'warn',
  'react-hooks/purity': 'warn',
  'react-hooks/globals': 'warn',
  'react-hooks/static-components': 'warn',
  'react-hooks/use-memo': 'warn',
  'react-hooks/preserve-manual-memoization': 'warn',
  'react-hooks/error-boundaries': 'warn',
  'react-hooks/config': 'warn',
  'react-hooks/gating': 'warn',
  // `incompatible-library` (TanStack Virtual's useVirtualizer in ResultsTable)
  // is already `warn` upstream; pin it so the intent is explicit and stable.
  'react-hooks/incompatible-library': 'warn',
}

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...REACT_COMPILER_RULES_AS_WARN,
      // react-refresh/only-export-components is a Vite Fast-Refresh DX hint, not
      // a correctness check: it fires whenever a module exports a component
      // ALONGSIDE a non-component value. Several modules here legitimately do
      // that by design — the router (src/router.tsx exports the `router`
      // instance + a RouteErrorFallback component), the entry wiring, and the
      // docs content tree (see the src/content/** block below). Demote it to a
      // warning project-wide so it never blocks the gate; it still shows up in
      // `npm run lint` output as guidance.
      'react-refresh/only-export-components': 'warn',
      // Honor the conventional underscore prefix for intentionally-unused
      // bindings. The canonical use here is dropping a key while spreading the
      // rest — `const { app: _omit, ...rest } = prev` (drop `app`, keep the
      // rest) — which is the idiomatic immutable "omit a property" pattern; the
      // `_omit` binding exists only to name what is being discarded. Without
      // this, typescript-eslint's recommended `no-unused-vars` errors on it.
      // Mirrors @typescript-eslint's own documented convention.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Docs content modules (src/content/**) deliberately co-locate static doc
    // DATA — the `DocPage` / `Recipe` constants and the documented API surface —
    // with the stateless presentational renderers that consume it. They hold no
    // component state, so Fast Refresh of them is a non-goal; the
    // react-refresh/only-export-components rule (which would force every data
    // constant into a separate module and fragment each page in two) does not
    // apply here. Disable it outright for this tree.
    files: ['src/content/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
