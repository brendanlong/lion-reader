/**
 * Google Reader API: Stream Item IDs
 *
 * GET /api/greader.php/reader/api/0/stream/items/ids
 *
 * Returns item IDs for a stream, without full content.
 * Used by clients to efficiently sync which items exist.
 *
 * Query parameters:
 * - s: stream ID (required)
 * - n: number of items (default 1000, max 10000)
 * - c: continuation token
 * - ot: oldest timestamp (unix seconds)
 * - nt: newest timestamp (unix seconds)
 * - r: sort order ("o" for oldest first)
 * - xt: exclude stream ID
 * - it: include tag (e.g., user/-/state/com.google/read to include only read items)
 */

import { requireAuth } from "@/server/google-reader/auth";
import { jsonResponse, errorResponse, withClientErrors } from "@/server/google-reader/parse";
import { isStreamError, resolveStreamListParams } from "@/server/google-reader/stream-filters";
import { entryFeedStreamId } from "@/server/google-reader/format";
import * as entriesService from "@/server/services/entries";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const GET = withClientErrors(async (request: Request): Promise<Response> => {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

  const url = new URL(request.url);
  const searchParams = url.searchParams;

  const streamIdStr = searchParams.get("s");
  if (!streamIdStr) {
    return errorResponse("Missing required parameter: s (stream ID)", 400);
  }

  const listParams = await resolveStreamListParams(db, session.user, streamIdStr, searchParams, {
    defaultCount: 1000,
    maxCount: 10000,
  });
  if (isStreamError(listParams)) return errorResponse(listParams.message, listParams.status);

  const result = await entriesService.listGreaderItemRefs(db, listParams);
  const itemRefs = result.items.map((ref) => {
    // The item's origin stream, as in its `origin`.
    const directStreamId = entryFeedStreamId(ref);
    return {
      id: ref.itemId.toString(),
      directStreamIds: directStreamId ? [directStreamId] : [],
      timestampUsec: (ref.fetchedAt.getTime() * 1000).toString(),
    };
  });

  const response: Record<string, unknown> = {
    itemRefs,
  };

  if (result.nextCursor) {
    response.continuation = result.nextCursor;
  }

  return jsonResponse(response);
});
