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
  const listParams: entriesService.ListEntriesParams = {
    userId: auth.userId,
    limit: params.perPage,
    sortOrder: params.order === "asc" ? "oldest" : "newest",
    showSpam: false,
  };

  // Filter by read/archived state
  if (params.archive === false) {
    listParams.unreadOnly = true;
  }

  // Filter by starred state
  if (params.starred === true) {
    listParams.starredOnly = true;
  }

  // Wallabag uses page-based pagination. We need to simulate this with cursor-based.
  // For page > 1, we need to skip (page - 1) * perPage entries.
  // We do this by fetching enough entries to cover the requested page.
  const skipCount = (params.page - 1) * params.perPage;

  // Get total count for pagination metadata
  const counts = await entriesService.countEntries(db, auth.userId, {
    unreadOnly: params.archive === false ? true : undefined,
    starredOnly: params.starred === true ? true : undefined,
    showSpam: false,
  });

  // For page-based pagination, fetch entries with offset simulation
  // We use a larger limit to skip to the right page
  const fetchLimit = skipCount + params.perPage;
  const result = await entriesService.listEntries(db, {
    ...listParams,
    limit: Math.min(fetchLimit, 100),
  });

  // Slice to the requested page
  const pageItems = result.items.slice(skipCount, skipCount + params.perPage);

  // If detail is "full", fetch full content for each entry
  let formattedItems;
  if (params.detail === "full") {
    formattedItems = await Promise.all(
      pageItems.map(async (entry) => {
        try {
          const full = await entriesService.getEntry(db, auth.userId, entry.id);
          return formatEntryFull(full);
        } catch {
          return formatEntryListItem(entry);
        }
      })
    );
  } else {
    formattedItems = pageItems.map(formatEntryListItem);
  }

  const baseUrl = `${url.origin}/api/wallabag/api/entries`;
  return jsonResponse(
    createPaginatedResponse(formattedItems, params.page, params.perPage, counts.total, baseUrl)
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
