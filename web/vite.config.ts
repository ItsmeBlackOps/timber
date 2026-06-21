import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// Same-origin in dev: proxy the Timber API so the SPA calls relative URLs and
// there is no CORS (server stays framework-free). Point at the local server.
const TIMBER_TARGET = process.env.TIMBER_TARGET ?? 'http://localhost:7710'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    proxy: {
      '/v1': TIMBER_TARGET,
      '/healthz': TIMBER_TARGET,
    },
  },
  build: {
    // Production chunking (Vite 8 / Rolldown). Route-level lazyRouteComponent
    // (router.tsx) already isolates the route-only payloads — recharts (/stats)
    // and the docs prose (/docs) — into their own lazy chunks so neither lands on
    // the Explore ("/") first paint. These groups additionally peel the framework
    // vendor out of the entry chunk so a routine app-code change no longer busts
    // the cache for ~120 kB gzip of rarely-changing React + TanStack runtime.
    //
    // `output.codeSplitting` is the non-deprecated Rolldown chunking API (the
    // Rollup-style `output.manualChunks` function is deprecated). Separators use
    // the [\\/] class so the tests match module ids on Windows too. The recharts
    // group has the higher priority so its (and d3's) modules are claimed there
    // first and never merged into the generic vendor chunk.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'recharts',
              test: /node_modules[\\/](recharts|d3-[^\\/]+|victory-vendor|decimal\.js-light)[\\/]/,
              priority: 20,
            },
            {
              name: 'vendor',
              test: /node_modules[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
  },
})
