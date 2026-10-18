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
 * - n: number of items (default 20, max 300)
 * - c: continuation token (cursor)
 * - ot: oldest timestamp (unix seconds) — exclude items older than this
 * - nt: newest timestamp (unix seconds) — exclude items newer than this
 * - r: sort order ("o" for oldest first, default newest first)
 * - xt: exclude stream ID (e.g., user/-/state/com.google/read to exclude read items)
 * - it: include stream ID (e.g., user/-/state/com.google/read for only read items)
 */

import { requireAuth } from "@/server/google-reader/auth";
import { jsonResponse, errorResponse, withClientErrors } from "@/server/google-reader/parse";
import { isStreamError, resolveStreamListParams } from "@/server/google-reader/stream-filters";
import { formatEntryAsItem } from "@/server/google-reader/format";
import * as entriesService from "@/server/services/entries";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

// Google Reader treats `stream/contents` with no stream id as the reading list.
const DEFAULT_STREAM_ID = "user/-/state/com.google/reading-list";

const handleStreamContents = withClientErrors(async function (
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

  const listParams = await resolveStreamListParams(
    db,
    session.user,
    streamIdStr,
    new URL(request.url).searchParams,
    // Capped lower than the ids stream: each item carries a full article body.
    { defaultCount: 20, maxCount: 300 }
  );
  if (isStreamError(listParams)) return errorResponse(listParams.message, listParams.status);

  // The page's serials, then its entries' content in one bulk read; an entry
  // deleted in between is left out.
  const result = await entriesService.listGreaderItemRefs(db, listParams);
  const fullEntries = await entriesService.getEntries(
    db,
    session.user.id,
    result.items.map((ref) => ref.id)
  );
  const refById = new Map(result.items.map((ref) => [ref.id, ref]));
  const items = fullEntries.flatMap((entry) => {
    const ref = refById.get(entry.id);
    return ref ? formatEntryAsItem(entry, ref) : [];
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
});

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
