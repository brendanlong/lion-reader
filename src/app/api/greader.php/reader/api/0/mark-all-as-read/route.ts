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
import { feedStreamIdToSubscriptionUuid } from "@/server/google-reader/id";
import { resolveTagByName } from "@/server/google-reader/tags";
import { eq, and, isNull, lte, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@/server/db";
import {
  userEntries,
  entries,
  subscriptions,
  subscriptionTags,
  userFeeds,
} from "@/server/db/schema";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuth(request);
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

  const now = new Date();

  // Build conditions for the update
  const conditions: SQL[] = [
    eq(userEntries.userId, userId),
    eq(userEntries.read, false),
    lte(userEntries.readChangedAt, now),
  ];

  // Add timestamp filter if provided
  if (beforeDate) {
    const beforeEntryIdsSubquery = db
      .select({ id: entries.id })
      .from(entries)
      .where(lte(entries.fetchedAt, beforeDate));

    conditions.push(inArray(userEntries.entryId, beforeEntryIdsSubquery));
  }

  // Filter by stream
  switch (parsedStream.type) {
    case "feed": {
      const subscriptionId = await feedStreamIdToSubscriptionUuid(
        db,
        userId,
        parsedStream.subscriptionInt64
      );
      if (!subscriptionId) {
        return textResponse("OK");
      }

      // Look up feed IDs for this subscription
      const subResult = await db
        .select({ feedIds: subscriptions.feedIds })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.id, subscriptionId),
            eq(subscriptions.userId, userId),
            isNull(subscriptions.unsubscribedAt)
          )
        )
        .limit(1);

      if (subResult.length === 0 || !subResult[0].feedIds) {
        return textResponse("OK");
      }

      const entryIdsSubquery = db
        .select({ id: entries.id })
        .from(entries)
        .where(inArray(entries.feedId, subResult[0].feedIds));

      conditions.push(inArray(userEntries.entryId, entryIdsSubquery));
      break;
    }
    case "state": {
      switch (parsedStream.state) {
        case "reading-list":
          // All entries — no additional filter
          break;
        case "starred":
          conditions.push(eq(userEntries.starred, true));
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

      // Subquery for feed IDs from subscriptions with this tag
      const taggedFeedIdsSubquery = db
        .select({
          feedId: sql<string>`unnest(${userFeeds.feedIds})`.as("feed_id"),
        })
        .from(subscriptionTags)
        .innerJoin(userFeeds, eq(subscriptionTags.subscriptionId, userFeeds.id))
        .where(eq(subscriptionTags.tagId, tag.id));

      const taggedEntryIdsSubquery = db
        .select({ id: entries.id })
        .from(entries)
        .where(inArray(entries.feedId, taggedFeedIdsSubquery));

      conditions.push(inArray(userEntries.entryId, taggedEntryIdsSubquery));
      break;
    }
  }

  // Execute the update
  await db
    .update(userEntries)
    .set({
      read: true,
      readChangedAt: now,
      updatedAt: now,
    })
    .where(and(...conditions));

  return textResponse("OK");
}
