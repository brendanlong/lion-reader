/**
 * Google Reader API: Stream Contents
 *
 * GET/POST /api/greader.php/reader/api/0/stream/contents/{streamId}
 *
 * Returns items (entries) for a given stream. The streamId can be:
 * - feed/{int64} — entries from a specific subscription
 * - user/-/state/com.google/reading-list — all entries
 * - user/-/state/com.google/starred — starred entries
 * - user/-/label/{name} — entries in a tag/folder
 *
 * Query parameters:
 * - n: number of items (default 20, max 1000)
 * - c: continuation token (cursor)
 * - ot: oldest timestamp (unix seconds) — exclude items older than this
 * - nt: newest timestamp (unix seconds) — exclude items newer than this
 * - r: sort order ("o" for oldest first, default newest first)
 * - xt: exclude stream ID (e.g., user/-/state/com.google/read to exclude read items)
 */

import { requireAuth } from "@/server/google-reader/auth";
import { jsonResponse, errorResponse } from "@/server/google-reader/parse";
import { parseStreamId, type StreamId } from "@/server/google-reader/streams";
import { formatEntryAsItem } from "@/server/google-reader/format";
import { feedStreamIdToSubscriptionUuid } from "@/server/google-reader/id";
import { resolveTagByName } from "@/server/google-reader/tags";
import * as entriesService from "@/server/services/entries";
import { db } from "@/server/db";
import { isState } from "@/server/google-reader/streams";

export const dynamic = "force-dynamic";

async function handleStreamContents(
  request: Request,
  params: Promise<{ streamId: string[] }>
): Promise<Response> {
  const session = await requireAuth(request);
  const { streamId: streamIdParts } = await params;

  // Reconstruct the stream ID from path segments
  const streamIdStr = streamIdParts.join("/");

  let parsedStream: StreamId;
  try {
    parsedStream = parseStreamId(streamIdStr);
  } catch {
    return errorResponse(`Invalid stream ID: ${streamIdStr}`, 400);
  }

  // Parse query/form parameters
  const url = new URL(request.url);
  const searchParams = url.searchParams;

  const count = Math.min(parseInt(searchParams.get("n") ?? "20", 10) || 20, 1000);
  const continuation = searchParams.get("c") ?? undefined;
  const sortOrder = searchParams.get("r") === "o" ? "oldest" : "newest";
  const excludeTarget = searchParams.get("xt");

  // Build list entries params
  const listParams: entriesService.ListEntriesParams = {
    userId: session.user.id,
    limit: count,
    cursor: continuation,
    sortOrder: sortOrder as "newest" | "oldest",
    showSpam: session.user.showSpam,
  };

  // Resolve stream ID to filter params
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
          // All entries — no additional filter
          break;
        case "starred":
          listParams.starredOnly = true;
          break;
        case "read":
          // Read entries — not directly supported by list params,
          // but we can handle via exclude logic below
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

  // Handle exclude target (xt parameter)
  if (excludeTarget && isState(excludeTarget, "read")) {
    listParams.unreadOnly = true;
  }

  // Fetch entries using service layer
  const result = await entriesService.listEntries(db, listParams);

  // Get full content for each entry
  const items = await Promise.all(
    result.items.map(async (entry) => {
      try {
        const full = await entriesService.getEntry(db, session.user.id, entry.id);
        return formatEntryAsItem(full);
      } catch {
        // If entry can't be fetched with full content, use list data
        return formatEntryAsItem({
          ...entry,
          contentOriginal: null,
          contentCleaned: null,
          feedUrl: null,
          unsubscribeUrl: null,
        });
      }
    })
  );

  const response: Record<string, unknown> = {
    direction: "ltr",
    id: streamIdStr,
    title: streamIdStr,
    updated: Math.floor(Date.now() / 1000),
    items,
  };

  if (result.nextCursor) {
    response.continuation = result.nextCursor;
  }

  return jsonResponse(response);
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ streamId: string[] }> }
): Promise<Response> {
  return handleStreamContents(request, ctx.params);
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ streamId: string[] }> }
): Promise<Response> {
  return handleStreamContents(request, ctx.params);
}
