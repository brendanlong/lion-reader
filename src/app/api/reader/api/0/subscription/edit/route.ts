/**
 * Google Reader API: Edit Subscription
 *
 * POST /api/reader/api/0/subscription/edit
 *
 * Edit, add, or remove subscriptions.
 *
 * Request body (form-encoded):
 *   ac={action}     — "subscribe", "unsubscribe", or "edit"
 *   s={streamId}    — feed stream ID (e.g., "feed/12345")
 *   t={title}       — new title (for edit/subscribe)
 *   a={tagToAdd}    — tag to add (can repeat, format: user/-/label/{name})
 *   r={tagToRemove} — tag to remove (can repeat, format: user/-/label/{name})
 */

import { requireAuth } from "@/server/google-reader/auth";
import { parseFormData, textResponse, errorResponse } from "@/server/google-reader/parse";
import { feedStreamIdToSubscriptionUuid } from "@/server/google-reader/id";
import { parseStreamId } from "@/server/google-reader/streams";
import { resolveTagByName } from "@/server/google-reader/tags";
import { db } from "@/server/db";
import { eq, and, isNull } from "drizzle-orm";
import { subscriptions, subscriptionTags } from "@/server/db/schema";
import * as tagsService from "@/server/services/tags";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  const userId = session.user.id;

  const params = await parseFormData(request);
  const action = params.get("ac");
  const streamIdStr = params.get("s");
  const title = params.get("t");
  const addTags = params.getAll("a");
  const removeTags = params.getAll("r");

  if (!action || !streamIdStr) {
    return errorResponse("Missing required parameters: ac and s", 400);
  }

  // Parse the stream ID to get the subscription int64
  let subscriptionInt64: bigint;
  try {
    const parsed = parseStreamId(streamIdStr);
    if (parsed.type !== "feed") {
      return errorResponse("Stream ID must be a feed stream ID", 400);
    }
    subscriptionInt64 = parsed.subscriptionInt64;
  } catch {
    return errorResponse(`Invalid stream ID: ${streamIdStr}`, 400);
  }

  switch (action) {
    case "subscribe": {
      // For subscribe via edit, the URL might be in the stream ID
      // Some clients pass the URL as the stream ID with a feed/ prefix
      // This is handled by quickadd, so return success if already subscribed
      const existingSubId = await feedStreamIdToSubscriptionUuid(db, userId, subscriptionInt64);
      if (existingSubId) {
        // Already subscribed — apply any tag/title changes
        if (title) {
          await db
            .update(subscriptions)
            .set({ customTitle: title, updatedAt: new Date() })
            .where(
              and(
                eq(subscriptions.id, existingSubId),
                eq(subscriptions.userId, userId),
                isNull(subscriptions.unsubscribedAt)
              )
            );
        }

        // Handle tag additions
        await applyTagChanges(db, userId, existingSubId, addTags, removeTags);

        return textResponse("OK");
      }
      // If subscription doesn't exist, we can't subscribe by int64 ID alone
      return errorResponse("Use quickadd to subscribe to new feeds", 400);
    }

    case "edit": {
      const subscriptionId = await feedStreamIdToSubscriptionUuid(db, userId, subscriptionInt64);
      if (!subscriptionId) {
        return errorResponse("Subscription not found", 404);
      }

      // Apply title change
      if (title) {
        await db
          .update(subscriptions)
          .set({ customTitle: title, updatedAt: new Date() })
          .where(
            and(
              eq(subscriptions.id, subscriptionId),
              eq(subscriptions.userId, userId),
              isNull(subscriptions.unsubscribedAt)
            )
          );
      }

      // Handle tag changes
      await applyTagChanges(db, userId, subscriptionId, addTags, removeTags);

      return textResponse("OK");
    }

    case "unsubscribe": {
      const subscriptionId = await feedStreamIdToSubscriptionUuid(db, userId, subscriptionInt64);
      if (!subscriptionId) {
        return textResponse("OK"); // Already unsubscribed
      }

      // Soft delete the subscription
      const now = new Date();

      // Remove tag associations
      await db.delete(subscriptionTags).where(eq(subscriptionTags.subscriptionId, subscriptionId));

      // Set unsubscribedAt
      await db
        .update(subscriptions)
        .set({ unsubscribedAt: now, updatedAt: now })
        .where(
          and(
            eq(subscriptions.id, subscriptionId),
            eq(subscriptions.userId, userId),
            isNull(subscriptions.unsubscribedAt)
          )
        );

      return textResponse("OK");
    }

    default:
      return errorResponse(`Unknown action: ${action}`, 400);
  }
}

/**
 * Applies tag additions and removals to a subscription.
 * Creates tags that don't exist yet.
 */
async function applyTagChanges(
  database: typeof db,
  userId: string,
  subscriptionId: string,
  addTags: string[],
  removeTags: string[]
): Promise<void> {
  // Process tag removals
  for (const tagStreamId of removeTags) {
    const labelMatch = tagStreamId.match(/^user\/[^/]+\/label\/(.+)$/);
    if (!labelMatch) continue;

    const tagName = labelMatch[1];
    const tag = await resolveTagByName(database, userId, tagName);
    if (tag) {
      await database
        .delete(subscriptionTags)
        .where(
          and(
            eq(subscriptionTags.subscriptionId, subscriptionId),
            eq(subscriptionTags.tagId, tag.id)
          )
        );
    }
  }

  // Process tag additions
  for (const tagStreamId of addTags) {
    const labelMatch = tagStreamId.match(/^user\/[^/]+\/label\/(.+)$/);
    if (!labelMatch) continue;

    const tagName = labelMatch[1];
    let tag = await resolveTagByName(database, userId, tagName);

    // Create tag if it doesn't exist
    if (!tag) {
      const newTag = await tagsService.createTag(database, userId, { name: tagName });
      tag = { id: newTag.id, name: newTag.name };
    }

    // Add tag to subscription (ignore if already exists)
    try {
      await database
        .insert(subscriptionTags)
        .values({
          subscriptionId,
          tagId: tag.id,
        })
        .onConflictDoNothing();
    } catch {
      // Ignore duplicate tag assignments
    }
  }
}
