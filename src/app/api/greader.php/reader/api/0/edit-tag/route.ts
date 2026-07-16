/**
 * Google Reader API: Edit Tag
 *
 * POST /api/greader.php/reader/api/0/edit-tag
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
import { greaderItemIdsToUuids } from "@/server/google-reader/id";
import { isState } from "@/server/google-reader/streams";
import * as entriesService from "@/server/services/entries";
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
  const uuidMap = await greaderItemIdsToUuids(db, itemIds);
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
    await entriesService.updateEntriesStarred(db, session.user.id, entryUuids, addStarred);
  }

  return textResponse("OK");
}
