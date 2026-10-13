/**
 * Google Reader API: Edit Subscription
 *
 * POST /api/greader.php/reader/api/0/subscription/edit
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
import {
  parseFormData,
  textResponse,
  errorResponse,
  clientErrorResponse,
} from "@/server/google-reader/parse";
import { feedStreamIdToSubscriptionUuid } from "@/server/google-reader/id";
import { parseStreamId } from "@/server/google-reader/streams";
import { resolveTagByName } from "@/server/google-reader/tags";
import { db } from "@/server/db";
import * as tagsService from "@/server/services/tags";
import {
  clearedCustomTitle,
  editSubscriptionTags,
  unsubscribe,
  updateSubscription,
} from "@/server/services/subscriptions";
import { getAppErrorCode } from "@/server/trpc/errors";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;
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
        // Already subscribed — apply any tag/title changes.
        return editSubscription(userId, existingSubId, title, addTags, removeTags);
      }
      // If subscription doesn't exist, we can't subscribe by int64 ID alone
      return errorResponse("Use quickadd to subscribe to new feeds", 400);
    }

    case "edit": {
      const subscriptionId = await feedStreamIdToSubscriptionUuid(db, userId, subscriptionInt64);
      if (!subscriptionId) {
        return errorResponse("Subscription not found", 404);
      }

      return editSubscription(userId, subscriptionId, title, addTags, removeTags);
    }

    case "unsubscribe": {
      const subscriptionId = await feedStreamIdToSubscriptionUuid(db, userId, subscriptionInt64);
      if (!subscriptionId) {
        return textResponse("OK"); // Already unsubscribed
      }

      await unsubscribe(db, userId, subscriptionId);
      return textResponse("OK");
    }

    default:
      return errorResponse(`Unknown action: ${action}`, 400);
  }
}

/**
 * Applies an edit's title and tag changes. A blank title is ignored, except
 * that a collection must keep a name (#1846).
 */
async function editSubscription(
  userId: string,
  subscriptionId: string,
  rawTitle: string | null,
  addTags: string[],
  removeTags: string[]
): Promise<Response> {
  try {
    const title = rawTitle?.trim();
    if (title) {
      await updateSubscription(db, userId, subscriptionId, { customTitle: title });
    } else if (title === "" && (await clearedCustomTitle(db, userId, subscriptionId)) === null) {
      return errorResponse("Collection name is required", 400);
    }

    const removeTagIds: string[] = [];
    for (const tagName of labelNames(removeTags)) {
      const tag = await resolveTagByName(db, userId, tagName);
      if (tag) removeTagIds.push(tag.id);
    }
    const addTagIds: string[] = [];
    for (const tagName of labelNames(addTags)) {
      const tag =
        (await resolveTagByName(db, userId, tagName)) ??
        (await tagsService.createTag(db, userId, { name: tagName })).tag;
      addTagIds.push(tag.id);
    }
    if (addTagIds.length > 0 || removeTagIds.length > 0) {
      await editSubscriptionTags(db, userId, subscriptionId, {
        add: addTagIds,
        remove: removeTagIds,
      });
    }
  } catch (error) {
    if (getAppErrorCode(error) === "COLLECTION_NAME_TAKEN") {
      return errorResponse(`Collection already exists: ${rawTitle?.trim()}`, 409);
    }
    const clientError = clientErrorResponse(error);
    if (clientError) return clientError;
    throw error;
  }
  return textResponse("OK");
}

/** The label names in `user/{id}/label/{name}` tag stream ids; other ids are skipped. */
function labelNames(tagStreamIds: string[]): string[] {
  return tagStreamIds.flatMap((id) => id.match(/^user\/[^/]+\/label\/(.+)$/)?.[1] ?? []);
}
