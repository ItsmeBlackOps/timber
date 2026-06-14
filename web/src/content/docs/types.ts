// Shared types for the in-app docs (F12). Docs are modeled as structured data
// (not opaque markdown) so two things stay honest and testable:
//   1. recipe Console links are built from typed Filters -> the real URL contract
//      (lib/filters), so a documented "all logs for a user" link can't drift from
//      what Explore actually parses;
//   2. the documented API surface is a machine-readable list that a test asserts
//      against the real server surface ("docs match API" — fails if an endpoint
//      or param is added without being documented).
import type { Filters } from "@/lib/filters";

/** One documented endpoint + the exact set of query params it accepts. */
export interface DocEndpoint {
  /** HTTP method + path, e.g. "GET /v1/logs". */
  method: "GET";
  path: string;
  /** Whether a Bearer key is required (healthz is open). */
  auth: boolean;
  /** Concrete query-param names. Family params use a `<…>` placeholder
   *  (e.g. "ids.<key>", "data.<path>", "data.<path>__gte") to denote the shape. */
  params: string[];
  /** One-line summary shown in the Query API reference page. */
  summary: string;
}

/** A documentation page: a stable slug, a title, and a React renderer. */
export interface DocPage {
  /** URL slug under /docs/<slug>. */
  slug: string;
  /** Nav + heading title. */
  title: string;
  /** Short blurb for the index/nav. */
  blurb: string;
  /** The page body. Rendered inside the docs route's content column. */
  Body: () => React.ReactElement;
}

/** A copy-pasteable recipe with a one-click Console deep link (spec §8.4 page 7). */
export interface Recipe {
  id: string;
  title: string;
  /** What it answers, in one line. */
  description: string;
  /** The equivalent curl command (uses $TIMBER_URL / $TIMBER_KEY like USAGE.md). */
  curl: string;
  /**
   * Filters that, serialized via lib/filters.filtersToParams, produce the
   * Console URL for this recipe (e.g. {ids:[{key:'userEmail',value:'…'}]} ->
   * /?ids.userEmail=…). Kept as Filters so the link is provably consistent with
   * the search contract.
   */
  filters: Filters;
  /** Which route the link targets ("/" Explore, or "/stats"). */
  route: "/" | "/stats";
}
