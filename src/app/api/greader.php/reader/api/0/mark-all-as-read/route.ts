/**
 * Google Reader API: Mark All As Read
 *
 * POST /api/greader.php/reader/api/0/mark-all-as-read
 *
 * Marks all items in a stream as read.
 *
 * Request body (form-encoded):
 *   s={streamId}     — stream to mark as read
 *   ts={timestamp}   — mark items older than this (microseconds since epoch)
 */

import { requireAuth } from "@/server/google-reader/auth";
import {
  parseFormData,
  textResponse,
  errorResponse,
  withClientErrors,
} from "@/server/google-reader/parse";
import { isStreamError, resolveStreamFilter } from "@/server/google-reader/stream-filters";
import { db } from "@/server/db";
import { markAllEntriesRead } from "@/server/services/entry-state";

export const dynamic = "force-dynamic";

export const POST = withClientErrors(async (request: Request): Promise<Response> => {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;
  const userId = session.user.id;
  const showSpam = session.user.showSpam;

  const params = await parseFormData(request);
  const streamIdStr = params.get("s");

  if (!streamIdStr) {
    return errorResponse("Missing required parameter: s (stream ID)", 400);
  }

  const filter = await resolveStreamFilter(db, userId, streamIdStr);
  if (isStreamError(filter)) {
    // A stream that's already gone has nothing left to mark: an offline
    // client replaying its queue mustn't be stuck on it.
    return filter.status === 404
      ? textResponse("OK")
      : errorResponse(filter.message, filter.status);
  }

  // Every item in the read stream is read already.
  const { readOnly, ...markFilter } = filter;
  if (!readOnly) {
    // `ts` is microseconds since the epoch.
    const ts = parseInt(params.get("ts") ?? "", 10);
    await markAllEntriesRead(db, {
      userId,
      showSpam,
      ...markFilter,
      before: isNaN(ts) ? undefined : new Date(ts / 1000),
    });
  }

  return textResponse("OK");
});
