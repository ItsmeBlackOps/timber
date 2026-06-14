import { setupServer } from 'msw/node'

// Shared MSW server. Default has no handlers — each test adds what it needs with
// server.use(http.get(...)). Task F13 may add a default fixture handler set.
export const server = setupServer()
