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

    return jsonResponse(formatSavedArticle(article));
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
