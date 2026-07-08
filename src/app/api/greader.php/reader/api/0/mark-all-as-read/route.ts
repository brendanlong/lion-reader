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
import { parseFormData, textResponse, errorResponse } from "@/server/google-reader/parse";
import { parseStreamId } from "@/server/google-reader/streams";
import { resolveFeedStreamFilter } from "@/server/google-reader/subscriptions";
import { resolveTagByName } from "@/server/google-reader/tags";
import { db } from "@/server/db";
import { markAllEntriesRead } from "@/server/services/entries";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;
  const userId = session.user.id;

  const params = await parseFormData(request);
  const streamIdStr = params.get("s");

  if (!streamIdStr) {
    return errorResponse("Missing required parameter: s (stream ID)", 400);
  }

  let parsedStream;
  try {
    parsedStream = parseStreamId(streamIdStr);
  } catch {
    return errorResponse(`Invalid stream ID: ${streamIdStr}`, 400);
  }

  // Parse optional timestamp (microseconds since epoch)
  const tsStr = params.get("ts");
  const beforeDate = tsStr ? new Date(parseInt(tsStr, 10) / 1000) : undefined;

  // Translate GReader stream into shared service params
  switch (parsedStream.type) {
    case "feed": {
      const filter = await resolveFeedStreamFilter(db, userId, parsedStream.subscriptionInt64);
      if (!filter) {
        return textResponse("OK");
      }

      // `filter` is the saved-feed type filter or a real subscription id (issue
      // #730), resolved identically to the stream/contents endpoints.
      await markAllEntriesRead(db, { userId, ...filter, before: beforeDate });
      break;
    }
    case "state": {
      switch (parsedStream.state) {
        case "reading-list":
          await markAllEntriesRead(db, {
            userId,
            before: beforeDate,
          });
          break;
        case "starred":
          await markAllEntriesRead(db, {
            userId,
            starredOnly: true,
            before: beforeDate,
          });
          break;
        default:
          return errorResponse(
            `Unsupported state for mark-all-as-read: ${parsedStream.state}`,
            400
          );
      }
      break;
    }
    case "label": {
      const tag = await resolveTagByName(db, userId, parsedStream.name);
      if (!tag) {
        return textResponse("OK");
      }

      await markAllEntriesRead(db, {
        userId,
        tagId: tag.id,
        before: beforeDate,
      });
      break;
    }
  }

  return textResponse("OK");
}
