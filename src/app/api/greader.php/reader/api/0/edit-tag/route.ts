/**
 * Google Reader API: Edit Tag
 *
 * POST /api/greader.php/reader/api/0/edit-tag
 *
 * Adds or removes tags from items. Used for:
 * - Marking items as read/unread
 * - Starring/unstarring items
 * - Adding items to and removing them from collections, which are item labels
 *   (#1821). Adding a label that doesn't exist creates the collection; a
 *   label naming a tag is ignored, since tags hold feeds, not articles.
 *
 * Request body (form-encoded):
 *   i={itemId}&i={itemId}&...    (item IDs to modify)
 *   a={tagToAdd}                 (tag to add, can repeat)
 *   r={tagToRemove}              (tag to remove, can repeat)
 *
 * Common tag operations:
 * - Mark read:   a=user/-/state/com.google/read
 * - Mark unread: r=user/-/state/com.google/read
 * - Star:        a=user/-/state/com.google/starred
 * - Unstar:      r=user/-/state/com.google/starred
 * - Collect:     a=user/-/label/{name}
 * - Uncollect:   r=user/-/label/{name}
 */

import { requireAuth } from "@/server/google-reader/auth";
import {
  parseFormData,
  parseItemIds,
  textResponse,
  errorResponse,
} from "@/server/google-reader/parse";
import { greaderItemIdsToUuids } from "@/server/google-reader/id";
import { listGreaderLabels } from "@/server/google-reader/labels";
import { isState, parseStreamId } from "@/server/google-reader/streams";
import * as entriesService from "@/server/services/entries";
import {
  addEntriesToCollection,
  createCollection,
  removeEntriesFromCollection,
} from "@/server/services/collections";
import { errors, getAppErrorCode } from "@/server/trpc/errors";
import { COLLECTION_NAME_MAX_LENGTH } from "@/lib/collections";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

// Bound the item-id list so a single call can't ask the server to issue an
// unbounded number of per-entry updates. Matches the cap on
// `stream/items/contents` and the services-layer bulk mutations (issue #1266).
const MAX_ITEM_IDS = 1000;

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuth(request);
  if (session instanceof Response) return session;

  const params = await parseFormData(request);

  let itemIds: bigint[];
  try {
    itemIds = parseItemIds(params);
  } catch {
    return errorResponse("Invalid item ID format", 400);
  }

  if (itemIds.length > MAX_ITEM_IDS) {
    return errorResponse(
      `Too many item ids: ${itemIds.length} requested, maximum ${MAX_ITEM_IDS} per request. Split into smaller batches.`,
      400
    );
  }

  if (itemIds.length === 0) {
    return textResponse("OK");
  }

  const addTags = params.getAll("a");
  const removeTags = params.getAll("r");

  // Resolve item IDs to UUIDs
  const uuidMap = await greaderItemIdsToUuids(db, session.user.id, itemIds);
  const entryUuids = Array.from(uuidMap.values());

  if (entryUuids.length === 0) {
    return textResponse("OK");
  }

  // Process read state changes
  const addRead = addTags.some((t) => isState(t, "read"));
  const removeRead = removeTags.some((t) => isState(t, "read"));

  const entriesToMark = entryUuids.map((id) => ({ id }));
  if (addRead) {
    await entriesService.markEntriesRead(db, session.user.id, entriesToMark, true);
  } else if (removeRead) {
    await entriesService.markEntriesRead(db, session.user.id, entriesToMark, false);
  }

  // Process starred state changes
  const addStarred = addTags.some((t) => isState(t, "starred"));
  const removeStarred = removeTags.some((t) => isState(t, "starred"));

  if (addStarred || removeStarred) {
    await entriesService.updateEntriesStarred(
      db,
      session.user.id,
      entryUuids.map((id) => ({ id })),
      addStarred
    );
  }

  try {
    await applyCollectionLabels(session.user.id, entryUuids, addTags, removeTags);
  } catch (error) {
    const code = getAppErrorCode(error);
    if (code === "VALIDATION_ERROR" || code === "MAX_SUBSCRIPTIONS_REACHED") {
      return errorResponse((error as Error).message, 400);
    }
    throw error;
  }

  return textResponse("OK");
}

function labelNames(streamIds: string[]): string[] {
  return streamIds.flatMap((streamId) => {
    try {
      const parsed = parseStreamId(streamId);
      const name = parsed.type === "label" ? parsed.name.trim() : "";
      return name ? [name] : [];
    } catch {
      return [];
    }
  });
}

async function applyCollectionLabels(
  userId: string,
  entryIds: string[],
  addTags: string[],
  removeTags: string[]
): Promise<void> {
  const toAdd = labelNames(addTags);
  const toRemove = labelNames(removeTags);
  if (toAdd.length === 0 && toRemove.length === 0) return;
  if (toAdd.some((name) => name.length > COLLECTION_NAME_MAX_LENGTH)) {
    throw errors.validation(`Labels must be at most ${COLLECTION_NAME_MAX_LENGTH} characters`);
  }

  const labels = await listGreaderLabels(db, userId);
  for (const name of toRemove) {
    const label = labels.find(name);
    if (label?.kind === "collection") {
      await removeEntriesFromCollection(db, userId, label.subscriptionId, entryIds);
    }
  }
  for (const name of toAdd) {
    const label = labels.find(name);
    if (label?.kind === "tag") continue;
    const subscriptionId =
      label?.subscriptionId ?? (await createCollection(db, userId, name)).subscription.id;
    await addEntriesToCollection(db, userId, subscriptionId, entryIds);
  }
}
