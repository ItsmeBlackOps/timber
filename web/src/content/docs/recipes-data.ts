// Recipe data (spec §8.4 page 7). Each recipe carries typed Filters; the docs
// route turns them into Console deep links via lib/filters.filtersToParams, so a
// link like "all logs for a user" provably equals what Explore parses
// (/?ids.userEmail=…). curl mirrors USAGE.md.
import type { Recipe } from "@/content/docs/types";
import { ALL_LEVELS } from "@/lib/filters";

const EXAMPLE_USER = "alice@example.com";

export const RECIPES: Recipe[] = [
  {
    id: "all-logs-for-a-user",
    title: "All logs for a user",
    description:
      "Every event correlated to one person, across all apps, via an ids.<key> filter.",
    curl: `curl -s "$TIMBER_URL/v1/logs?ids.userEmail=${EXAMPLE_USER}" \\
  -H "Authorization: Bearer $TIMBER_KEY"`,
    filters: {
      levels: [],
      ids: [{ key: "userEmail", value: EXAMPLE_USER }],
      data: [],
    },
    route: "/",
  },
  {
    id: "errors-last-hour-for-service",
    title: "Errors last hour for a service",
    description:
      "Warn + error events from one app within a time window — the on-call triage view.",
    curl: `curl -s "$TIMBER_URL/v1/logs?app=dailyDashboard&level=warn,error&from=2026-06-11T13:00:00Z" \\
  -H "Authorization: Bearer $TIMBER_KEY"`,
    filters: {
      app: "dailyDashboard",
      levels: ["warn", "error"],
      ids: [],
      data: [],
    },
    route: "/",
  },
  {
    id: "ai-cost-today-by-model",
    title: "AI cost today, by model",
    description:
      "Group ai.* events by data.model and read the cost on the Stats page.",
    curl: `curl -s "$TIMBER_URL/v1/groupby?by=data.model&event=ai." \\
  -H "Authorization: Bearer $TIMBER_KEY"`,
    filters: {
      event: "ai.",
      levels: [],
      ids: [],
      data: [],
    },
    route: "/stats",
  },
  {
    id: "slow-queries",
    title: "Slow queries",
    description:
      "DB queries above a latency threshold via a data.<path> numeric range.",
    curl: `curl -s "$TIMBER_URL/v1/logs?event=db.&data.latencyMs__gte=300" \\
  -H "Authorization: Bearer $TIMBER_KEY"`,
    filters: {
      event: "db.",
      levels: [],
      ids: [],
      data: [{ path: "latencyMs", op: "gte", value: "300" }],
    },
    route: "/",
  },
  {
    id: "everything-for-one-request",
    title: "Everything for one request",
    description:
      "Follow a single requestId across services to reconstruct one trace.",
    curl: `curl -s "$TIMBER_URL/v1/logs?ids.requestId=req-8f31" \\
  -H "Authorization: Bearer $TIMBER_KEY"`,
    filters: {
      levels: [],
      ids: [{ key: "requestId", value: "req-8f31" }],
      data: [],
    },
    route: "/",
  },
  {
    id: "all-events-all-levels",
    title: "Cursor walk (drain a query)",
    description:
      "Page through a broad query with the opaque nextCursor until it is null.",
    curl: `# page 1
curl -s "$TIMBER_URL/v1/logs?app=scraper&limit=500" -H "Authorization: Bearer $TIMBER_KEY"
# page 2 — paste nextCursor back verbatim
curl -s "$TIMBER_URL/v1/logs?app=scraper&limit=500&cursor=<nextCursor>" \\
  -H "Authorization: Bearer $TIMBER_KEY"`,
    filters: {
      app: "scraper",
      // explicit all-levels selection serializes to no `level` param (contract C-F3)
      levels: [...ALL_LEVELS],
      ids: [],
      data: [],
      limit: 500,
    },
    route: "/",
  },
];
