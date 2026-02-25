/**
 * Wallabag API: Entries Collection
 *
 * GET  /api/wallabag/api/entries - List entries with filtering and pagination
 * POST /api/wallabag/api/entries - Create a new entry (save a URL)
 *
 * Query parameters for GET:
 * - archive: 0|1 - filter by archived (read) state
 * - starred: 0|1 - filter by starred state
 * - sort: created|updated|archived - sort field (default: created)
 * - order: asc|desc - sort order (default: desc)
 * - page: number - page number (default: 1)
 * - perPage: number - items per page (default: 30, max: 100)
 * - tags: string - comma-separated tag names
 * - since: number - unix timestamp, return entries modified since
 * - detail: metadata|full - level of detail (default: full)
 *
 * POST body:
 * - url: string (required) - URL to save
 * - title: string - optional title override
 * - tags: string - comma-separated tags
 * - archive: 0|1 - mark as archived (read)
 * - starred: 0|1 - mark as starred
 * - content: string - optional content override
 */

import { requireAuth } from "@/server/wallabag/auth";
import {
  jsonResponse,
  errorResponse,
  parseEntryListParams,
  parseBody,
} from "@/server/wallabag/parse";
import {
  formatEntryFull,
  formatEntryListItem,
  formatSavedArticle,
  createPaginatedResponse,
} from "@/server/wallabag/format";
import * as entriesService from "@/server/services/entries";
import * as savedService from "@/server/services/saved";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  const url = new URL(request.url);
  const params = parseEntryListParams(url);

  // Build list params from Wallabag query params
  // Scope to saved articles only — the Wallabag API is a read-it-later interface
  const baseParams: entriesService.ListEntriesParams = {
    userId: auth.userId,
    type: "saved",
    limit: params.perPage,
    sortOrder: params.order === "asc" ? "oldest" : "newest",
    showSpam: false,
  };

  // Filter by read/archived state
  if (params.archive === false) {
    baseParams.unreadOnly = true;
  } else if (params.archive === true) {
    baseParams.readOnly = true;
  }

  // Filter by starred state
  if (params.starred === true) {
    baseParams.starredOnly = true;
  } else if (params.starred === false) {
    baseParams.unstarredOnly = true;
  }

  // Get total count for pagination metadata (Wallabag API needs total for offset pagination)
  const total = await entriesService.countTotalEntries(db, auth.userId, {
    type: "saved",
    unreadOnly: params.archive === false ? true : undefined,
    readOnly: params.archive === true ? true : undefined,
    starredOnly: params.starred === true ? true : undefined,
    unstarredOnly: params.starred === false ? true : undefined,
    showSpam: false,
  });

  // Simulate page-based pagination by iterating through cursor-based pages.
  // Skip (page - 1) pages of entries, then return the requested page.
  let cursor: string | undefined;
  for (let p = 1; p < params.page; p++) {
    const skipResult = await entriesService.listEntries(db, {
      ...baseParams,
      cursor,
    });
    cursor = skipResult.nextCursor;
    if (!cursor) {
      // Requested page is beyond available data
      const baseUrl = `${url.origin}/api/wallabag/api/entries`;
      return jsonResponse(createPaginatedResponse([], params.page, params.perPage, total, baseUrl));
    }
  }

  // Fetch the actual requested page
  const result = await entriesService.listEntries(db, {
    ...baseParams,
    cursor,
  });

  // If detail is "full", fetch full content in a single bulk query
  let formattedItems;
  if (params.detail === "full") {
    const fullEntries = await entriesService.getEntries(
      db,
      auth.userId,
      result.items.map((e) => e.id)
    );
    const fullMap = new Map(fullEntries.map((e) => [e.id, e]));
    formattedItems = result.items.map((entry) => {
      const full = fullMap.get(entry.id);
      return full ? formatEntryFull(full) : formatEntryListItem(entry);
    });
  } else {
    formattedItems = result.items.map(formatEntryListItem);
  }

  const baseUrl = `${url.origin}/api/wallabag/api/entries`;
  return jsonResponse(
    createPaginatedResponse(formattedItems, params.page, params.perPage, total, baseUrl)
  );
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  const body = await parseBody(request);

  const articleUrl = body.url;
  if (!articleUrl) {
    return errorResponse("invalid_request", "url is required", 400);
  }

  // Save the article
  const article = await savedService.saveArticle(db, auth.userId, {
    url: articleUrl,
    title: body.title || undefined,
  });

  // Handle archive/starred flags if provided
  if (body.archive === "1" && !article.read) {
    await entriesService.markEntriesRead(db, auth.userId, [article.id], true);
  }
  if (body.starred === "1" && !article.starred) {
    await entriesService.updateEntryStarred(db, auth.userId, article.id, true);
  }

  return jsonResponse(formatSavedArticle(article));
}
