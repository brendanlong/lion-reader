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
  clientErrorResponse,
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
import { entryIdToWallabagId } from "@/server/wallabag/id";
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

  try {
    // Save the article
    const article = await savedService.saveArticle(db, auth.userId, {
      url: articleUrl,
      title: body.title || undefined,
      // Use the user's stored Google credentials for private Google Docs when
      // already linked/granted (no interactive consent possible from an API
      // client). Falls back to a clean 4xx pointing at the web app otherwise.
      googleDocsAuth: "non-interactive",
    });

    // Handle archive/starred flags if provided
    if (body.archive === "1" && !article.read) {
      await entriesService.markEntriesRead(db, auth.userId, [{ id: article.id }], true);
    }
    if (body.starred === "1" && !article.starred) {
      await entriesService.updateEntryStarred(db, auth.userId, article.id, true);
    }

    // SavedArticle doesn't carry the entry serial (it's returned verbatim by
    // MCP save_article, which must stay bigint-free), so look it up — a
    // primary-key seek on the entry we just saved.
    const wallabagId = await entryIdToWallabagId(db, article.id);
    if (wallabagId === null) {
      // Only possible if the entry was deleted between the save and this seek.
      return errorResponse("not_found", "Entry not found", 404);
    }

    return jsonResponse(formatSavedArticle(article, wallabagId));
  } catch (error) {
    // saveArticle throws a TRPCError when the user-provided URL can't be fetched
    // (e.g. a 404 from a mistyped/markdown-artifact URL). Return that as a clean
    // Wallabag error envelope instead of an unhandled 500 that hits Sentry;
    // genuine server errors (null) still propagate.
    const clientError = clientErrorResponse(error);
    if (clientError) return clientError;
    throw error;
  }
}
