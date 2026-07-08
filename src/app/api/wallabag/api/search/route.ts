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
import { jsonResponse, errorResponse, parseEntryListParams } from "@/server/wallabag/parse";
import { formatEntryListItem, createPaginatedResponse } from "@/server/wallabag/format";
import * as entriesService from "@/server/services/entries";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const url = new URL(request.url);

  const term = url.searchParams.get("term");
  if (!term) {
    return errorResponse("invalid_request", "term parameter is required", 400);
  }

  // Reuse the shared page/perPage parsing (clamped identically to the list endpoint).
  const { page, perPage } = parseEntryListParams(url);

  // Serve the requested page with a single indexed query via LIMIT/OFFSET.
  const result = await entriesService.listEntries(db, {
    userId: auth.userId,
    query: term,
    type: "saved",
    limit: perPage,
    offset: (page - 1) * perPage,
    showSpam: false,
  });

  // Estimate total: for search results we don't have an efficient count query,
  // so compute a lower bound from the page position and whether there are more results.
  const itemsSoFar = (page - 1) * perPage + result.items.length;
  const total = result.nextCursor ? itemsSoFar + 1 : itemsSoFar;

  const items = result.items.map(formatEntryListItem);
  const baseUrl = `${url.origin}/api/wallabag/api/search`;
  return jsonResponse(createPaginatedResponse(items, page, perPage, total, baseUrl));
}
