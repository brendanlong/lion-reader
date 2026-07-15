/**
 * Wallabag API: Entries Collection
 *
 * GET  /api/wallabag/api/entries - List entries with filtering and pagination
 * POST /api/wallabag/api/entries - Create a new entry (save a URL)
 *
 * Query parameters for GET:
 * - archive: 0|1 - filter by archived (read) state
 * - starred: 0|1 - filter by starred state
 * - sort: created|updated|archived - sort field (default: created). `created` and
 *   `archived` are index-backed; `updated` (last-modified) would require an
 *   un-indexed GREATEST sort (see #1070) so it is approximated as `created`.
 * - order: asc|desc - sort order (default: desc)
 * - page: number - page number (default: 1)
 * - perPage: number - items per page (default: 30, max: 100)
 * - tags: string - comma-separated tag names (unsupported: saved articles carry
 *   no tags, so any tag filter returns an empty result rather than being ignored)
 * - since: number - unix timestamp, return entries modified since
 * - domain_name: string - filter by domain (unsupported: matching it would mean a
 *   per-row regex over the URL with no index, so any domain filter returns empty)
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

import { TRPCError } from "@trpc/server";
import { requireAuth } from "@/server/wallabag/auth";
import {
  jsonResponse,
  errorResponse,
  clientErrorResponse,
  parseEntryListParams,
  parseBody,
} from "@/server/wallabag/parse";
import { getAppErrorCode } from "@/server/trpc/errors";
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
  const baseUrl = `${url.origin}/api/wallabag/api/entries`;

  // Two filters we deliberately don't support, each answered with an empty result
  // rather than a silently-unfiltered list (issue #1062):
  //  - `tags`: Lion Reader tags are per-subscription, and saved articles (the
  //    Wallabag surface) have no subscription, so nothing can carry a tag.
  //  - `domain_name`: matching a domain means a per-row regex over the entry URL
  //    with no index — a potential per-user table scan (DB CPU is expensive), and
  //    not worth it for a rarely-used compat knob (issue #1070 has the analysis).
  if (params.tags.length > 0 || params.domainName) {
    return jsonResponse(createPaginatedResponse([], params.page, params.perPage, 0, baseUrl));
  }

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

  // Wallabag `sort` field → listEntries sort column. `created` (default) is our
  // publish/fetch-time sort; `archived` sorts by when read state last changed
  // (our closest analogue to Wallabag's archived_at). `updated` (last-modified)
  // would need an un-indexed GREATEST(entry, user_entry) sort with no LIMIT
  // pushdown (issue #1070), so we approximate it as the default `created` sort
  // rather than risk a per-user scan.
  const sortBy = params.sort === "archived" ? "archived" : "published";

  // Serve the requested page with a single indexed query via LIMIT/OFFSET, and
  // fetch the total count in parallel (Wallabag needs it for page metadata).
  const [result, total] = await Promise.all([
    entriesService.listEntries(db, {
      ...filter,
      userId: auth.userId,
      limit: params.perPage,
      offset: (params.page - 1) * params.perPage,
      sortOrder: params.order === "asc" ? "oldest" : "newest",
      sortBy,
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
    // the cause. Note this also placeholders the *transient* client-coded
    // failures (UPSTREAM_RATE_LIMITED, SITE_BLOCKED); a plain app re-share won't
    // then heal them (see the trade-off note on savePlaceholderArticle) — but
    // draining the queue beats leaving it jammed for every other save.
    if (clientErrorResponse(error) !== null) {
      const placeholder = await savedService.savePlaceholderArticle(db, auth.userId, {
        url: articleUrl,
        reason: describeSaveFailure(error),
      });
      const wallabagId = await entryIdToWallabagId(db, placeholder.id);
      if (wallabagId === null) {
        return errorResponse("not_found", "Entry not found", 404);
      }
      return jsonResponse(formatSavedArticle(placeholder, wallabagId));
    }
    throw error;
  }
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
