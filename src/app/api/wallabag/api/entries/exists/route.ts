/**
 * Wallabag API: Entry Exists
 *
 * GET /api/wallabag/api/entries/exists?url={url}
 *
 * Check if an entry with the given URL exists.
 * Returns { exists: true/false } and optionally the entry ID.
 *
 * Query parameters:
 * - url: string - URL to check
 * - urls: string[] - multiple URLs to check (alternative)
 * - return_id: 0|1 - whether to return the entry ID (default: 0)
 */

import { requireAuth } from "@/server/wallabag/auth";
import { jsonResponse, errorResponse } from "@/server/wallabag/parse";
import { uuidToWallabagId } from "@/server/wallabag/format";
import { normalizeUrl } from "@/lib/url";
import { eq, and } from "drizzle-orm";
import { db } from "@/server/db";
import { entries, userEntries } from "@/server/db/schema";
import { getOrCreateSavedFeed } from "@/server/feed/saved-feed";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  const url = new URL(request.url);

  const singleUrl = url.searchParams.get("url");
  const returnId = url.searchParams.get("return_id") === "1";

  if (!singleUrl) {
    return errorResponse("invalid_request", "url parameter is required", 400);
  }

  const normalizedUrl = normalizeUrl(singleUrl);
  const savedFeedId = await getOrCreateSavedFeed(db, auth.userId);

  const existing = await db
    .select({ id: entries.id })
    .from(entries)
    .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
    .where(
      and(
        eq(entries.feedId, savedFeedId),
        eq(entries.guid, normalizedUrl),
        eq(userEntries.userId, auth.userId)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    const result: Record<string, unknown> = { exists: true };
    if (returnId) {
      result.id = uuidToWallabagId(existing[0].id);
    }
    return jsonResponse(result);
  }

  return jsonResponse({ exists: false });
}
