import { Component, StrictMode } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { router } from '@/router'
import '@/styles.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

/**
 * Top-level error boundary — the SPA's last-resort net.
 *
 * Per-route TanStack `errorComponent`s and the router's `defaultErrorComponent`
 * (see router.tsx) catch throws *inside* a matched route while keeping the
 * persistent shell. But a throw *above* the router — router internals, the
 * QueryClientProvider tree, or RootShell itself before any route renders — has no
 * route boundary to catch it and would otherwise unmount the whole app to a blank
 * page. This classic React error boundary catches those and renders a branded,
 * recoverable fallback instead.
 *
 * Recovery here is a full page reload rather than a soft reset: an above-router
 * crash means the app never finished mounting (or RootShell itself is broken), so
 * re-rendering the same tree would just throw again — reloading from scratch is
 * the only reliable way back.
 */
export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the crash in the console for diagnosis; the UI stays recoverable.
    console.error('Timber Console crashed:', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return (
      <div
        style={{
          minHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 24,
          background: 'var(--tb-bg)',
          color: 'var(--tb-text)',
        }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontWeight: 700,
            fontSize: 16,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 10,
              height: 16,
              borderRadius: 2,
              background: 'var(--tb-acc)',
              display: 'inline-block',
            }}
          />
          <span>Timber</span>
        </div>
        <div
          role="alert"
          style={{
            maxWidth: 560,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            padding: '16px 18px',
            background: 'var(--tb-surface)',
            border: '1px solid var(--tb-border)',
            borderInlineStart: '3px solid var(--tb-error)',
            borderRadius: 6,
            textAlign: 'center',
          }}
        >
          <strong style={{ fontSize: 15 }}>Something went wrong</strong>
          <span style={{ color: 'var(--tb-mut)', fontSize: 14 }}>
            The console hit an unexpected error and couldn't render. Reloading
            usually clears it.
          </span>
          <div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: '1px solid var(--tb-border)',
                background: 'var(--tb-2)',
                color: 'var(--tb-text)',
                cursor: 'pointer',
                fontSize: 14,
              }}
            >
              Reload app
            </button>
          </div>
        </div>
      </div>
    )
  }
}

// Guard the mount on a real #root so importing this module is side-effect-free
// under test (jsdom has no #root); in the browser index.html provides it.
const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <AppErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </AppErrorBoundary>
    </StrictMode>,
  )
}
