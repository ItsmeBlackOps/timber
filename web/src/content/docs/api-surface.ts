// The documented Timber query-API surface (authored to match USAGE.md + the
// server's query module: src/query/{logs,stats,events,facets,groupby}.js and
// /healthz). The Query API reference page renders this, and the "docs match API"
// test (docs-api-surface.test.ts) asserts it equals an independent fixture — so
// adding a server endpoint or param without documenting it fails the build.
import type { DocEndpoint } from "@/content/docs/types";

/**
 * Param families shared by /v1/logs and /v1/groupby (the "logs filter surface").
 * groupby reuses src/query/logs.js's buildLogsFilter, so its filter params are
 * identical to logs — minus `cursor` (groupby drops it) and `limit` (groupby's
 * `limit` means top-N groups, included explicitly below).
 */
const LOGS_FILTER_PARAMS = [
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
] as const;

export const DOCUMENTED_ENDPOINTS: DocEndpoint[] = [
  {
    method: "GET",
    path: "/v1/logs",
    auth: true,
    params: [...LOGS_FILTER_PARAMS, "limit", "cursor"],
    summary:
      "Search log documents, newest-first, with keyset (cursor) pagination.",
  },
  {
    method: "GET",
    path: "/v1/stats",
    auth: true,
    params: ["group", "from", "to", "app", "event"],
    summary:
      "Time-bucketed rollups: volume, error rate, AI cost/tokens, latency percentiles.",
  },
  {
    method: "GET",
    path: "/v1/events",
    auth: true,
    params: ["app"],
    summary: "Distinct event names seen per app (drives filter dropdowns).",
  },
  {
    method: "GET",
    path: "/v1/facets",
    auth: true,
    params: ["app", "from", "to"],
    summary:
      "Discover which ids.<key> and data.<path> fields occur in a window.",
  },
  {
    method: "GET",
    path: "/v1/groupby",
    auth: true,
    params: [...LOGS_FILTER_PARAMS, "by", "limit", "like"],
    summary:
      "Count documents grouped by one field over the logs filter surface (top-N + otherCount).",
  },
  {
    method: "GET",
    path: "/healthz",
    auth: false,
    params: [],
    summary: "Liveness + WAL / flusher / Mongo subsystem state (no auth).",
  },
];

/** Lookup by path for the reference page. */
export function endpointByPath(path: string): DocEndpoint | undefined {
  return DOCUMENTED_ENDPOINTS.find((e) => e.path === path);
}
