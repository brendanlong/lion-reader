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
import * as savedService from "@/server/services/saved";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  const url = new URL(request.url);

  const singleUrl = url.searchParams.get("url");
  const returnId = url.searchParams.get("return_id") === "1";

  if (!singleUrl) {
    return errorResponse("invalid_request", "url parameter is required", 400);
  }

  const entryId = await savedService.savedArticleExistsByUrl(db, auth.userId, singleUrl);

  if (entryId) {
    const result: Record<string, unknown> = { exists: true };
    if (returnId) {
      result.id = uuidToWallabagId(entryId);
    }
    return jsonResponse(result);
  }

  return jsonResponse({ exists: false });
}
