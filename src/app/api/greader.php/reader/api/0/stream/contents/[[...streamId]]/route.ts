/**
 * Google Reader API: Stream Contents
 *
 * GET/POST /api/greader.php/reader/api/0/stream/contents/{streamId}
 * GET/POST /api/greader.php/reader/api/0/stream/contents   (streamId omitted)
 *
 * Returns items (entries) for a given stream. The streamId can be:
 * - feed/{int64} — entries from a specific subscription
 * - user/-/state/com.google/reading-list — all entries
 * - user/-/state/com.google/starred — starred entries
 * - user/-/label/{name} — entries in a tag/folder
 *
 * When the streamId is omitted entirely (this is an optional catch-all route),
 * it defaults to the reading-list, matching Google Reader semantics where
 * `stream/contents` with no stream id returns the reading list. Newsflash's
 * FreshRSS backend relies on this: its initial sync fetches "latest" articles
 * by calling `stream/contents` with no stream id, so a required catch-all would
 * 404 that request and break account setup.
 *
 * Query parameters:
 * - n: number of items (default 20, max 300) — capped lower than the ids stream
 *   because each item carries a full (potentially large, sanitized) article body
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
import { resolveFeedStreamFilter } from "@/server/google-reader/subscriptions";
import { resolveTagByName } from "@/server/google-reader/tags";
import * as entriesService from "@/server/services/entries";
import { db } from "@/server/db";
import { isState } from "@/server/google-reader/streams";

export const dynamic = "force-dynamic";

// Google Reader treats `stream/contents` with no stream id as the reading list.
const DEFAULT_STREAM_ID = "user/-/state/com.google/reading-list";

async function handleStreamContents(
  request: Request,
  params: Promise<{ streamId?: string[] }>
): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;
  const { streamId: streamIdParts } = await params;

  // Reconstruct the stream ID from path segments. On the optional catch-all,
  // `streamIdParts` is undefined when the streamId is omitted — default it to
  // the reading list.
  const streamIdStr =
    streamIdParts && streamIdParts.length > 0 ? streamIdParts.join("/") : DEFAULT_STREAM_ID;

  let parsedStream: StreamId;
  try {
    parsedStream = parseStreamId(streamIdStr);
  } catch {
    return errorResponse(`Invalid stream ID: ${streamIdStr}`, 400);
  }

  // Parse query/form parameters
  const url = new URL(request.url);
  const searchParams = url.searchParams;

  const count = Math.min(parseInt(searchParams.get("n") ?? "20", 10) || 20, 300);
  const continuation = searchParams.get("c") ?? undefined;
  const sortOrder = searchParams.get("r") === "o" ? "oldest" : "newest";
  const excludeTarget = searchParams.get("xt");
  const olderThan = searchParams.get("ot");
  const newerThan = searchParams.get("nt");

  // Build list entries params
  const listParams: entriesService.ListEntriesParams = {
    userId: session.user.id,
    limit: count,
    maxLimit: 300,
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

  // Resolve stream ID to filter params
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
          // All entries — no additional filter
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

  // Get full content in a single bulk query rather than one getEntry per entry.
  const fullEntries = await entriesService.getEntries(
    db,
    session.user.id,
    result.items.map((e) => e.id)
  );
  const fullMap = new Map(fullEntries.map((e) => [e.id, e]));
  const items = result.items.map((entry) => {
    const full = fullMap.get(entry.id);
    // If full content isn't available, fall back to list data.
    return formatEntryAsItem(
      full ?? {
        ...entry,
        contentOriginal: null,
        contentCleaned: null,
        feedUrl: null,
        unsubscribeUrl: null,
      }
    );
  });

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
  ctx: { params: Promise<{ streamId?: string[] }> }
): Promise<Response> {
  return handleStreamContents(request, ctx.params);
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ streamId?: string[] }> }
): Promise<Response> {
  return handleStreamContents(request, ctx.params);
}
