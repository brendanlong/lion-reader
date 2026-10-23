/**
 * Wallabag API: Entries Collection
 *
 * GET  /api/wallabag/api/entries - List entries with filtering and pagination
 * POST /api/wallabag/api/entries - Create a new entry (save a URL)
 *
 * Query parameters for GET:
 * - archive: 0|1 - filter by archived (read) state
 * - starred: 0|1 - filter by starred state
 * - sort: created|updated|archived - ignored: every list sorts by `created`. No
 *   client we know of needs the others, and `archived` would sort Saved by read
 *   time, which has no index (#2114).
 * - order: asc|desc - sort order (default: desc)
 * - page: number - page number (default: 1)
 * - perPage: number - items per page (default: 30, max: 100)
 * - tags: string - comma-separated tag labels; entries carrying all of them
 * - since: number - unix timestamp, return entries modified since
 * - domain_name: string - filter by domain (unsupported: matching it would mean a
 *   per-row regex over the URL with no index, so any domain filter returns empty)
 * - detail: metadata|full - level of detail (default: full)
 *
 * POST body:
 * - url: string (required) - URL to save
 * - title: string - optional title override
 * - tags: string - comma-separated tag labels to add, creating missing tags
 * - archive: 0|1 - mark as archived (read)
 * - starred: 0|1 - mark as starred
 * - content: string - optional content override
 */

import { TRPCError } from "@trpc/server";
import { requireAuth } from "@/server/wallabag/auth";
import {
  jsonResponse,
  errorResponse,
  clientErrorResponse,
  parseEntryListParams,
  parseBody,
  parseTagLabels,
  withClientErrors,
} from "@/server/wallabag/parse";
import { getAppErrorCode } from "@/server/errors";
import { formatSavedArticle, createPaginatedResponse } from "@/server/wallabag/format";
import { listWallabagEntries } from "@/server/wallabag/entries";
import * as entryStateService from "@/server/services/entry-state";
import * as savedService from "@/server/services/saved";
import { entryIdsToWallabagIds } from "@/server/wallabag/id";
import { addEntryTags, listEntryTags } from "@/server/wallabag/tags";
import { logger } from "@/lib/logger";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const GET = withClientErrors(async function (request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const url = new URL(request.url);
  const params = parseEntryListParams(url);
  const baseUrl = `${url.origin}/api/wallabag/api/entries`;

  const { items, total } = await listWallabagEntries(db, auth.userId, params);
  return jsonResponse(createPaginatedResponse(items, params.page, params.perPage, total, baseUrl));
});

export async function POST(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const body = await parseBody(request);

  const articleUrl = body.url;
  if (!articleUrl) {
    return errorResponse("invalid_request", "url is required", 400);
  }
  const tagLabels = parseTagLabels(body.tags);

  try {
    // Save the article
    const article = await savedService.saveArticle(db, auth.userId, {
      url: articleUrl,
      title: body.title || undefined,
      // Use the user's stored Google credentials for private Google Docs when
      // already linked/granted (no interactive consent possible from an API
      // client). Falls back to a clean 4xx pointing at the web app otherwise.
      userAuth: "non-interactive",
    });

    // Handle archive/starred flags if provided
    if (body.archive === "1" && !article.read) {
      await entryStateService.markEntriesRead(db, auth.userId, [{ id: article.id }], true);
    }
    if (body.starred === "1" && !article.starred) {
      await entryStateService.updateEntryStarred(db, auth.userId, article.id, true);
    }

    return await savedArticleResponse(auth.userId, article, tagLabels);
  } catch (error) {
    // The Wallabag Android app's offline save queue only advances an item on a
    // 2xx response; any error keeps it queued, retried forever, AND halts every
    // newer queued save behind it (a poison item — #1254). So for a client-side
    // save failure (oversized page, 404, blocked site, feed URL, private doc
    // needing auth) we can't return the 4xx — we save a labeled placeholder
    // entry (URL as title, reason as body) and return it with 200, which drains
    // the queue and tells the user in-app why the save failed.
    //
    // `clientErrorResponse` returning non-null is exactly the "expected
    // client/upstream failure, not our bug" signal (a 4xx, or an expected
    // upstream 5xx like SITE_BLOCKED). A genuine server bug returns null and
    // still throws → 500, so the app legitimately retries it once we've fixed
    // the cause. The placeholder is flagged is_placeholder, so a later re-share
    // of the same URL always refetches it (see savePlaceholderArticle / #1256) —
    // a transient failure (UPSTREAM_RATE_LIMITED, SITE_BLOCKED) heals on the next
    // re-share instead of being stuck behind the placeholder.
    if (clientErrorResponse(error) !== null) {
      const placeholder = await savedService.savePlaceholderArticle(db, auth.userId, {
        url: articleUrl,
        reason: describeSaveFailure(error),
      });
      return await savedArticleResponse(auth.userId, placeholder, tagLabels);
    }
    throw error;
  }
}

/**
 * Tags the just-saved article and formats it. Tagging is best effort: a failure
 * here must not fail the save (see the poison-queue note in POST).
 */
async function savedArticleResponse(
  userId: string,
  article: savedService.SavedArticle,
  tagLabels: string[]
): Promise<Response> {
  try {
    await addEntryTags(db, userId, article.id, tagLabels);
  } catch (error) {
    logger.warn("Wallabag save: skipped adding tags", {
      component: "wallabag",
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const [wallabagIds, tagsByEntry] = await Promise.all([
    entryIdsToWallabagIds(db, userId, [article.id]),
    listEntryTags(db, userId, [article.id]),
  ]);
  const wallabagId = wallabagIds.get(article.id);
  if (wallabagId === undefined) {
    // Only possible if the entry was deleted between the save and this seek.
    return errorResponse("not_found", "Entry not found", 404);
  }
  return jsonResponse(formatSavedArticle(article, wallabagId, tagsByEntry.get(article.id) ?? []));
}

/**
 * Human-readable reason for a failed save, used as the placeholder entry body.
 * Most service errors already carry a user-facing message; `URL_IS_FEED` is a
 * bare machine code, so translate it into advice.
 */
function describeSaveFailure(error: unknown): string {
  if (getAppErrorCode(error) === "URL_IS_FEED") {
    return "This looks like a feed URL. Subscribe to it in Lion Reader instead of saving it.";
  }
  if (error instanceof TRPCError) return error.message;
  return "The page could not be fetched.";
}
