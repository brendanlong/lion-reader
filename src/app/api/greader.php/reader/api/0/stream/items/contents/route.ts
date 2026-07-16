/**
 * Google Reader API: Stream Item Contents
 *
 * POST /api/greader.php/reader/api/0/stream/items/contents
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
 *
 * The client supplies the id list explicitly (there is no server-side cursor to
 * paginate it), so callers are expected to batch: page ids via stream/items/ids
 * and post them in bounded chunks. We enforce an upper bound with a 400 rather
 * than assembling an unbounded number of full (potentially large, sanitized)
 * article bodies into one response — a runaway request should split, not stall.
 */

import { requireAuth } from "@/server/google-reader/auth";
import {
  parseFormData,
  parseItemIds,
  jsonResponse,
  errorResponse,
} from "@/server/google-reader/parse";
import { formatEntryAsItem } from "@/server/google-reader/format";
import { greaderItemIdsToUuids } from "@/server/google-reader/id";
import * as entriesService from "@/server/services/entries";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

/**
 * Maximum item ids accepted per request. Generous (well-behaved clients batch
 * far smaller — typically 50–250), but bounded so a single call can't ask the
 * server to assemble tens of thousands of full article bodies at once.
 */
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
    return jsonResponse({
      direction: "ltr",
      id: "user/-/state/com.google/reading-list",
      items: [],
    });
  }

  // Batch resolve item IDs to UUIDs
  const uuidMap = await greaderItemIdsToUuids(db, session.user.id, itemIds);

  // Fetch full entries in a single bulk query (mirrors the Wallabag route)
  // rather than one getEntry per id. getEntries returns entries in the order of
  // the given UUIDs and silently skips ones that can't be found (deleted, not
  // visible to the user, etc.).
  const uuids = [...uuidMap.values()];
  const entries = await entriesService.getEntries(db, session.user.id, uuids);
  const items = entries.map(formatEntryAsItem);

  return jsonResponse({
    direction: "ltr",
    id: "user/-/state/com.google/reading-list",
    updated: Math.floor(Date.now() / 1000),
    items,
  });
}
