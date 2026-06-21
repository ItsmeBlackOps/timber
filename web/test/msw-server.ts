import { setupServer } from 'msw/node'

import { defaultHandlers } from './handlers'

// Shared MSW server, seeded with the Task F13 default fixture handler set
// (./handlers.ts → PRD §5.2 fixtures in ./fixtures.ts). Because these are the
// handlers passed to setupServer(), `server.resetHandlers()` (run in setup.ts's
// afterEach) reverts to them after every test — so any route/component that
// renders discovery-driven children gets realistic data for free. Tests still
// override a single endpoint per-case with `server.use(http.get(...))`.
export const server = setupServer(...defaultHandlers)
