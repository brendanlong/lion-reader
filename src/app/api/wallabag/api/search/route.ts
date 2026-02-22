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

  const result = await entriesService.listEntries(db, {
    userId: auth.userId,
    query: term,
    limit: perPage,
    showSpam: false,
  });

  const items = result.items.map(formatEntryListItem);
  const baseUrl = `${url.origin}/api/wallabag/api/search`;
  return jsonResponse(createPaginatedResponse(items, page, perPage, items.length, baseUrl));
}
