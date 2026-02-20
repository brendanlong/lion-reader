/**
 * Google Reader API: Stream Item Contents
 *
 * POST /api/reader/api/0/stream/items/contents
 *
 * Returns full item contents for specific item IDs.
 * Used by clients after fetching IDs via stream/items/ids.
 *
 * Request body (form-encoded):
 *   i={itemId}&i={itemId}&...
 *
 * Item IDs can be in any of the three formats:
 * - Long hex: tag:google.com,2005:reader/item/000000000000001F
 * - Short hex: 000000000000001F
 * - Decimal: 31
 */

import { requireAuth } from "@/server/google-reader/auth";
import {
  parseFormData,
  parseItemIds,
  jsonResponse,
  errorResponse,
} from "@/server/google-reader/parse";
import { formatEntryAsItem } from "@/server/google-reader/format";
import { batchInt64ToUuid } from "@/server/google-reader/id";
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
    return jsonResponse({
      direction: "ltr",
      id: "user/-/state/com.google/reading-list",
      items: [],
    });
  }

  // Batch resolve int64 IDs to UUIDs
  const uuidMap = await batchInt64ToUuid(db, itemIds);

  // Fetch full entries for resolved UUIDs
  const items = [];
  for (const [, uuid] of uuidMap) {
    try {
      const entry = await entriesService.getEntry(db, session.user.id, uuid);
      items.push(formatEntryAsItem(entry));
    } catch {
      // Skip entries that can't be found (deleted, not visible to user, etc.)
    }
  }

  return jsonResponse({
    direction: "ltr",
    id: "user/-/state/com.google/reading-list",
    updated: Math.floor(Date.now() / 1000),
    items,
  });
}
