import { Link, Outlet } from '@tanstack/react-router'

// Placeholder shell — Task F4 replaces this with the real top bar (brand, app
// switcher, health dot, theme toggle, settings).
export function RootShell() {
  return (
    <div style={{ minHeight: '100%' }}>
      <nav style={{ display: 'flex', gap: 16, padding: 12, borderBottom: '1px solid var(--tb-border)' }}>
        <Link to="/">Explore</Link>
        <Link to="/stats">Stats</Link>
        <Link to="/docs/$page" params={{ page: 'overview' }}>Docs</Link>
      </nav>
      <Outlet />
    </div>
  )
}
