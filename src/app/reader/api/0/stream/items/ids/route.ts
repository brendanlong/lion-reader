/**
 * Google Reader API: Stream Item IDs
 *
 * GET /reader/api/0/stream/items/ids
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
 */

import { requireAuth } from "@/server/google-reader/auth";
import { jsonResponse, errorResponse } from "@/server/google-reader/parse";
import { parseStreamId } from "@/server/google-reader/streams";
import { uuidToInt64 } from "@/server/google-reader/id";
import { feedStreamIdToSubscriptionUuid } from "@/server/google-reader/id";
import { resolveTagByName } from "@/server/google-reader/tags";
import { isState } from "@/server/google-reader/streams";
import * as entriesService from "@/server/services/entries";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);

  const url = new URL(request.url);
  const searchParams = url.searchParams;

  const streamIdStr = searchParams.get("s");
  if (!streamIdStr) {
    return errorResponse("Missing required parameter: s (stream ID)", 400);
  }

  let parsedStream;
  try {
    parsedStream = parseStreamId(streamIdStr);
  } catch {
    return errorResponse(`Invalid stream ID: ${streamIdStr}`, 400);
  }

  const count = Math.min(parseInt(searchParams.get("n") ?? "1000", 10) || 1000, 10000);
  const continuation = searchParams.get("c") ?? undefined;
  const sortOrder = searchParams.get("r") === "o" ? "oldest" : "newest";
  const excludeTarget = searchParams.get("xt");

  const listParams: entriesService.ListEntriesParams = {
    userId: session.user.id,
    limit: count,
    cursor: continuation,
    sortOrder: sortOrder as "newest" | "oldest",
    showSpam: session.user.showSpam,
  };

  switch (parsedStream.type) {
    case "feed": {
      const subscriptionId = await feedStreamIdToSubscriptionUuid(
        db,
        session.user.id,
        parsedStream.subscriptionInt64
      );
      if (!subscriptionId) {
        return errorResponse("Subscription not found", 404);
      }
      listParams.subscriptionId = subscriptionId;
      break;
    }
    case "state": {
      switch (parsedStream.state) {
        case "reading-list":
          break;
        case "starred":
          listParams.starredOnly = true;
          break;
        default:
          return errorResponse(`Unsupported state: ${parsedStream.state}`, 400);
      }
      break;
    }
    case "label": {
      const tag = await resolveTagByName(db, session.user.id, parsedStream.name);
      if (!tag) {
        return errorResponse(`Tag not found: ${parsedStream.name}`, 404);
      }
      listParams.tagId = tag.id;
      break;
    }
  }

  if (excludeTarget && isState(excludeTarget, "read")) {
    listParams.unreadOnly = true;
  }

  const result = await entriesService.listEntries(db, listParams);

  const itemRefs = result.items.map((entry) => {
    const int64Id = uuidToInt64(entry.id);
    return {
      id: int64Id.toString(),
      directStreamIds: entry.subscriptionId
        ? [`feed/${uuidToInt64(entry.subscriptionId).toString()}`]
        : [],
      timestampUsec: (entry.fetchedAt.getTime() * 1000).toString(),
    };
  });

  const response: Record<string, unknown> = {
    itemRefs,
  };

  if (result.nextCursor) {
    response.continuation = result.nextCursor;
  }

  return jsonResponse(response);
}
