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
  if (auth instanceof Response) return auth;
  const url = new URL(request.url);
  const params = parseEntryListParams(url);

  // Scope to saved articles only — the Wallabag API is a read-it-later interface.
  // The read/starred/since filters are shared by the page query and the count so
  // the two can't drift.
  const filter = {
    type: "saved" as const,
    showSpam: false,
    unreadOnly: params.archive === false ? true : undefined,
    readOnly: params.archive === true ? true : undefined,
    starredOnly: params.starred === true ? true : undefined,
    unstarredOnly: params.starred === false ? true : undefined,
    // Wallabag `since` (unix seconds) means "entries *updated* since" — clients
    // use it to pull new saves AND archive/star state changes for delta sync.
    // updatedAfter filters on GREATEST(entry.updated_at, user_entries.updated_at),
    // which captures all three, so this is correct (not a lossy save-time proxy).
    updatedAfter: params.since ? new Date(params.since * 1000) : undefined,
  };

  // Serve the requested page with a single indexed query via LIMIT/OFFSET, and
  // fetch the total count in parallel (Wallabag needs it for page metadata).
  const [result, total] = await Promise.all([
    entriesService.listEntries(db, {
      ...filter,
      userId: auth.userId,
      limit: params.perPage,
      offset: (params.page - 1) * params.perPage,
      sortOrder: params.order === "asc" ? "oldest" : "newest",
    }),
    entriesService.countTotalEntries(db, auth.userId, filter),
  ]);

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
  if (auth instanceof Response) return auth;
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

  // Handle archive/starred flags if provided. computeCounts: false — this route
  // discards the return value and only needs the state change to sync to other
  // tabs (published count-less), so it skips the visible_entries count scans
  // (see #1045/#1046).
  if (body.archive === "1" && !article.read) {
    await entriesService.markEntriesRead(db, auth.userId, [{ id: article.id }], true, {
      computeCounts: false,
    });
  }
  if (body.starred === "1" && !article.starred) {
    await entriesService.updateEntryStarred(db, auth.userId, article.id, true, {
      computeCounts: false,
    });
  }

  return jsonResponse(formatSavedArticle(article));
}
