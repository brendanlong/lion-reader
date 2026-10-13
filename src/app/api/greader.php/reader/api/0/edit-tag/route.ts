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
import { getAppErrorCode } from "@/server/trpc/errors";
import { COLLECTION_NAME_MAX_LENGTH, MAX_SAVE_COLLECTIONS } from "@/lib/collections";
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

  // Checked before any change, so a rejected request changes nothing.
  const collectionChanges = await planCollectionChanges(session.user.id, addTags, removeTags);
  if ("error" in collectionChanges) {
    return errorResponse(collectionChanges.error, 400);
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
    await applyCollectionChanges(session.user.id, entryUuids, collectionChanges);
  } catch (error) {
    const code = getAppErrorCode(error);
    // A full collection, or the subscription cap reached by a new one.
    if (code === "VALIDATION_ERROR" || code === "MAX_SUBSCRIPTIONS_REACHED") {
      return errorResponse((error as Error).message, 400);
    }
    if (code === "COLLECTION_NAME_TAKEN") {
      return errorResponse((error as Error).message, 409);
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

interface CollectionChanges {
  removeFrom: string[];
  addTo: string[];
  create: string[];
}

/**
 * Resolves the request's labels to collections: removals of anything but a
 * collection and additions of a tag are ignored, and an unknown added label
 * is a collection to create.
 */
async function planCollectionChanges(
  userId: string,
  addTags: string[],
  removeTags: string[]
): Promise<CollectionChanges | { error: string }> {
  const changes: CollectionChanges = { removeFrom: [], addTo: [], create: [] };
  const toAdd = labelNames(addTags);
  const toRemove = labelNames(removeTags);
  if (toAdd.length === 0 && toRemove.length === 0) return changes;

  const labels = await listGreaderLabels(db, userId);
  for (const name of toRemove) {
    const label = labels.find(name);
    if (label?.kind === "collection") changes.removeFrom.push(label.subscriptionId);
  }
  const createKeys = new Set<string>();
  for (const name of toAdd) {
    const label = labels.find(name);
    if (label?.kind === "collection") {
      if (!changes.addTo.includes(label.subscriptionId)) changes.addTo.push(label.subscriptionId);
    } else if (!label && !createKeys.has(name.toLowerCase())) {
      createKeys.add(name.toLowerCase());
      changes.create.push(name);
    }
  }

  if (changes.addTo.length + changes.create.length > MAX_SAVE_COLLECTIONS) {
    return { error: `At most ${MAX_SAVE_COLLECTIONS} labels can be added at once` };
  }
  if (changes.create.some((name) => name.length > COLLECTION_NAME_MAX_LENGTH)) {
    return { error: `Labels must be at most ${COLLECTION_NAME_MAX_LENGTH} characters` };
  }
  return changes;
}

async function applyCollectionChanges(
  userId: string,
  entryIds: string[],
  { removeFrom, addTo, create }: CollectionChanges
): Promise<void> {
  for (const subscriptionId of removeFrom) {
    await skipIfDeleted(removeEntriesFromCollection(db, userId, subscriptionId, entryIds));
  }
  for (const subscriptionId of addTo) {
    await skipIfDeleted(addEntriesToCollection(db, userId, subscriptionId, entryIds));
  }
  for (const name of create) {
    const { subscription } = await createCollection(db, userId, name);
    await skipIfDeleted(addEntriesToCollection(db, userId, subscription.id, entryIds));
  }
}

/** A collection deleted since the labels were read is skipped, like an unknown label. */
async function skipIfDeleted(change: Promise<unknown>): Promise<void> {
  try {
    await change;
  } catch (error) {
    if (getAppErrorCode(error) !== "SUBSCRIPTION_NOT_FOUND") throw error;
  }
}
