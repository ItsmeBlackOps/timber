// The ordered docs registry (spec §8.4): the 8 pages, in reading order, plus
// lookup helpers used by the docs route and its tests.
import type { DocPage } from "@/content/docs/types";
import { overview } from "@/content/docs/overview";
import { quickstart } from "@/content/docs/quickstart";
import { eventContract } from "@/content/docs/event-contract";
import { conventions } from "@/content/docs/conventions";
import { sendingLogs } from "@/content/docs/sending-logs";
import { queryApi } from "@/content/docs/query-api";
import { recipes } from "@/content/docs/recipes";
import { keys } from "@/content/docs/keys";

/** All docs pages in nav/reading order. */
export const DOC_PAGES: DocPage[] = [
  overview,
  quickstart,
  eventContract,
  conventions,
  sendingLogs,
  queryApi,
  recipes,
  keys,
];

/** The slug shown when /docs has no (or an unknown) page. */
export const DEFAULT_DOC_SLUG = overview.slug;

/** Look up a page by slug; undefined when not found. */
export function getDoc(slug: string | undefined): DocPage | undefined {
  if (!slug) return undefined;
  return DOC_PAGES.find((p) => p.slug === slug);
}
