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
import { jsonResponse, errorResponse } from "@/server/google-reader/parse";
import { parseStreamId } from "@/server/google-reader/streams";
import { entryFeedStreamId } from "@/server/google-reader/format";
import { resolveGreaderIdsForEntries } from "@/server/google-reader/id";
import { resolveFeedStreamFilter } from "@/server/google-reader/subscriptions";
import { labelFilter, listGreaderLabels } from "@/server/google-reader/labels";
import { isState } from "@/server/google-reader/streams";
import * as entriesService from "@/server/services/entries";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

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
  const includeTarget = searchParams.get("it");
  const olderThan = searchParams.get("ot");
  const newerThan = searchParams.get("nt");

  const listParams: entriesService.ListEntriesParams = {
    userId: session.user.id,
    limit: count,
    maxLimit: 10000,
    cursor: continuation,
    sortOrder: sortOrder as "newest" | "oldest",
    showSpam: session.user.showSpam,
  };

  // ot = "older than" timestamp — only return items newer than this (published after)
  if (olderThan) {
    const ts = parseInt(olderThan, 10);
    if (!isNaN(ts)) {
      listParams.publishedAfter = new Date(ts * 1000);
    }
  }

  // nt = "newer than" timestamp — only return items older than this (published before)
  if (newerThan) {
    const ts = parseInt(newerThan, 10);
    if (!isNaN(ts)) {
      listParams.publishedBefore = new Date(ts * 1000);
    }
  }

  switch (parsedStream.type) {
    case "feed": {
      const filter = await resolveFeedStreamFilter(
        db,
        session.user.id,
        parsedStream.subscriptionInt64
      );
      if (!filter) {
        return errorResponse("Subscription not found", 404);
      }
      Object.assign(listParams, filter);
      break;
    }
    case "state": {
      switch (parsedStream.state) {
        case "reading-list":
          break;
        case "starred":
          listParams.starredOnly = true;
          break;
        case "read":
          listParams.readOnly = true;
          break;
        default:
          return errorResponse(`Unsupported state: ${parsedStream.state}`, 400);
      }
      break;
    }
    case "label": {
      const label = (await listGreaderLabels(db, session.user.id)).find(parsedStream.name);
      if (!label) {
        return errorResponse(`Label not found: ${parsedStream.name}`, 404);
      }
      Object.assign(listParams, labelFilter(label));
      break;
    }
  }

  if (excludeTarget && isState(excludeTarget, "read")) {
    listParams.unreadOnly = true;
  }

  // Handle include target (it parameter) — e.g., it=user/-/state/com.google/read
  if (includeTarget) {
    try {
      const parsed = parseStreamId(includeTarget);
      if (parsed.type === "state") {
        switch (parsed.state) {
          case "read":
            listParams.readOnly = true;
            break;
          case "starred":
            listParams.starredOnly = true;
            break;
        }
      }
    } catch {
      // Ignore invalid stream IDs for the 'it' parameter
    }
  }

  const result = await entriesService.listEntries(db, listParams);

  const idsByEntry = await resolveGreaderIdsForEntries(
    db,
    session.user.id,
    result.items.map((e) => e.id)
  );
  const itemRefs = result.items.flatMap((entry) => {
    const ids = idsByEntry.get(entry.id);
    if (!ids) return [];
    // The item's origin stream, as in its `origin`.
    const directStreamId = entryFeedStreamId(ids);
    return {
      id: ids.itemId.toString(),
      directStreamIds: directStreamId ? [directStreamId] : [],
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
