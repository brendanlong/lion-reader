/**
 * Wallabag API: Search
 *
 * GET /api/wallabag/api/search?term={term}
 *
 * Search entries by term.
 *
 * Query parameters:
 * - term: string (required) - search term
 * - page: number - page number (default: 1)
 * - perPage: number - items per page (default: 30)
 */

import { requireAuth } from "@/server/wallabag/auth";
import { jsonResponse, errorResponse } from "@/server/wallabag/parse";
import { formatEntryListItem, createPaginatedResponse } from "@/server/wallabag/format";
import * as entriesService from "@/server/services/entries";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  const url = new URL(request.url);

  const term = url.searchParams.get("term");
  if (!term) {
    return errorResponse("invalid_request", "term parameter is required", 400);
  }

  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const perPage = Math.min(
    Math.max(1, parseInt(url.searchParams.get("perPage") ?? "30", 10) || 30),
    100
  );

  const searchParams: entriesService.ListEntriesParams = {
    userId: auth.userId,
    query: term,
    type: "saved",
    limit: perPage,
    showSpam: false,
  };

  // Simulate page-based pagination by iterating through cursor-based pages.
  let cursor: string | undefined;
  for (let p = 1; p < page; p++) {
    const skipResult = await entriesService.listEntries(db, {
      ...searchParams,
      cursor,
    });
    cursor = skipResult.nextCursor;
    if (!cursor) {
      // Requested page is beyond available data
      const baseUrl = `${url.origin}/api/wallabag/api/search`;
      return jsonResponse(createPaginatedResponse([], page, perPage, 0, baseUrl));
    }
  }

  // Fetch the actual requested page
  const result = await entriesService.listEntries(db, {
    ...searchParams,
    cursor,
  });

  // Estimate total: for search results we don't have an efficient count query,
  // so compute a lower bound from the page position and whether there are more results.
  const itemsSoFar = (page - 1) * perPage + result.items.length;
  const total = result.nextCursor ? itemsSoFar + 1 : itemsSoFar;

  const items = result.items.map(formatEntryListItem);
  const baseUrl = `${url.origin}/api/wallabag/api/search`;
  return jsonResponse(createPaginatedResponse(items, page, perPage, total, baseUrl));
}
