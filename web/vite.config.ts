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
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
  },
})
