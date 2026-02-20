/**
 * Google Reader API: Edit Tag
 *
 * POST /reader/api/0/edit-tag
 *
 * Adds or removes tags from items. Used for:
 * - Marking items as read/unread
 * - Starring/unstarring items
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
 */

import { requireAuth } from "@/server/google-reader/auth";
import {
  parseFormData,
  parseItemIds,
  textResponse,
  errorResponse,
} from "@/server/google-reader/parse";
import { batchInt64ToUuid } from "@/server/google-reader/id";
import { isState } from "@/server/google-reader/streams";
import * as entriesService from "@/server/services/entries";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const session = await requireAuth(request);

  const params = await parseFormData(request);

  let itemIds: bigint[];
  try {
    itemIds = parseItemIds(params);
  } catch {
    return errorResponse("Invalid item ID format", 400);
  }

  if (itemIds.length === 0) {
    return textResponse("OK");
  }

  const addTags = params.getAll("a");
  const removeTags = params.getAll("r");

  // Resolve int64 IDs to UUIDs
  const uuidMap = await batchInt64ToUuid(db, itemIds);
  const entryUuids = Array.from(uuidMap.values());

  if (entryUuids.length === 0) {
    return textResponse("OK");
  }

  // Process read state changes
  const addRead = addTags.some((t) => isState(t, "read"));
  const removeRead = removeTags.some((t) => isState(t, "read"));

  if (addRead) {
    await entriesService.markEntriesRead(db, session.user.id, entryUuids, true);
  } else if (removeRead) {
    await entriesService.markEntriesRead(db, session.user.id, entryUuids, false);
  }

  // Process starred state changes
  const addStarred = addTags.some((t) => isState(t, "starred"));
  const removeStarred = removeTags.some((t) => isState(t, "starred"));

  if (addStarred || removeStarred) {
    for (const entryId of entryUuids) {
      await entriesService.updateEntryStarred(db, session.user.id, entryId, addStarred);
    }
  }

  return textResponse("OK");
}
