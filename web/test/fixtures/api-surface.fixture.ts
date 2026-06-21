// Independent description of the REAL Timber query-API surface, transcribed
// from the server source of truth:
//   - src/query/logs.js     (parseLogsQuery / buildLogsFilter): app, env, level,
//                            event, from, to, q, ids.<key>, data.<path>(+__gte/__lte),
//                            limit, cursor
//   - src/query/stats.js    KNOWN_PARAMS: group, from, to, app, event
//   - src/query/events.js   KNOWN_PARAMS: app
//   - src/query/facets.js   KNOWN_PARAMS: app, from, to
//   - src/query/groupby.js  OWN_PARAMS by/limit/like + reuses buildLogsFilter
//                            (the full logs filter surface, minus cursor)
//   - GET /healthz          no params, no auth
//
// The "docs match API" test (src/content/docs/docs-api-surface.test.ts) asserts
// the docs' DOCUMENTED_ENDPOINTS equals this fixture. If a server endpoint or
// param changes without the docs being updated, the test fails — keeping the
// in-app reference authoritative (spec §8.4: "a test asserts documented
// endpoints/params match the real API surface").
//
// This fixture is intentionally maintained separately from the docs data so the
// two can disagree; they are compared, not shared.

export interface ApiSurfaceEntry {
  path: string;
  auth: boolean;
  /** Exact param names; family params use the `<…>` placeholder shape. */
  params: string[];
}

/** The logs filter surface shared by /v1/logs and /v1/groupby. */
const LOGS_FILTER = [
  "app",
  "env",
  "level",
  "event",
  "from",
  "to",
  "q",
  "ids.<key>",
  "data.<path>",
  "data.<path>__gte",
  "data.<path>__lte",
];

export const API_SURFACE: ApiSurfaceEntry[] = [
  {
    path: "/v1/logs",
    auth: true,
    params: [...LOGS_FILTER, "limit", "cursor"],
  },
  {
    path: "/v1/stats",
    auth: true,
    params: ["group", "from", "to", "app", "event"],
  },
  {
    path: "/v1/events",
    auth: true,
    params: ["app"],
  },
  {
    path: "/v1/facets",
    auth: true,
    params: ["app", "from", "to"],
  },
  {
    path: "/v1/groupby",
    auth: true,
    // logs filter surface (minus cursor) + groupby's own knobs
    params: [...LOGS_FILTER, "by", "limit", "like"],
  },
  {
    path: "/healthz",
    auth: false,
    params: [],
  },
];
