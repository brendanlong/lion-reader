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
import { batchInt64ToUuid } from "@/server/google-reader/id";
import { isState } from "@/server/google-reader/streams";
import * as entriesService from "@/server/services/entries";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

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

  // computeCounts: false — this route discards the return value and only needs
  // the read/starred state to sync to other tabs (published count-less). Google
  // Reader clients (Reeder, NetNewsWire, …) mark read/star at high volume, and
  // the star path below loops per entry, so skipping the several visible_entries
  // count scans per call avoids a large amount of DB CPU (see #1045/#1046).
  const entriesToMark = entryUuids.map((id) => ({ id }));
  if (addRead) {
    await entriesService.markEntriesRead(db, session.user.id, entriesToMark, true, {
      computeCounts: false,
    });
  } else if (removeRead) {
    await entriesService.markEntriesRead(db, session.user.id, entriesToMark, false, {
      computeCounts: false,
    });
  }

  // Process starred state changes
  const addStarred = addTags.some((t) => isState(t, "starred"));
  const removeStarred = removeTags.some((t) => isState(t, "starred"));

  if (addStarred || removeStarred) {
    for (const entryId of entryUuids) {
      await entriesService.updateEntryStarred(db, session.user.id, entryId, addStarred, {
        computeCounts: false,
      });
    }
  }

  return textResponse("OK");
}
