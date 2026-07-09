/**
 * Entry State Change Events
 *
 * Shared "publish entry_state_changed after a mutation" logic so the tRPC
 * routers and the MCP tools stay in sync. Both surfaces mark entries read and
 * star/unstar via the same services, so both must emit the same SSE events for
 * multi-tab/device sync — extracting this here keeps the mcp-scoped endpoints
 * mirroring the MCP tools exactly (see DESIGN.md).
 *
 * All publishing is fire-and-forget: SSE is best-effort and must never block or
 * fail the mutation response.
 */

import { publishEntryStateChanged } from "@/server/redis/pubsub";
import {
  toBulkUnreadCounts,
  type BulkUnreadCounts,
  type UnreadCounts,
} from "@/server/services/counts";
import type { EntryState, MarkReadEntryState } from "@/server/services/entries";

/**
 * Publishes an entry_state_changed event for each entry affected by a bulk
 * markRead, carrying the absolute counts so other tabs set them directly.
 */
export function publishMarkReadStateChanges(
  userId: string,
  entries: MarkReadEntryState[],
  counts: BulkUnreadCounts
): void {
  for (const entry of entries) {
    void publishEntryStateChanged(
      userId,
      entry.id,
      entry.read,
      entry.starred,
      entry.updatedAt,
      counts
    ).catch(() => {
      // Ignore publish errors - SSE is best-effort
    });
  }
}

/**
 * Publishes an entry_state_changed event after a single-entry star/unstar,
 * normalizing the single-entry UnreadCounts into the array-shaped counts the
 * event (and the client's setBulkCounts) expects.
 */
export function publishStarredStateChange(
  userId: string,
  entry: EntryState,
  counts: UnreadCounts
): void {
  void publishEntryStateChanged(
    userId,
    entry.id,
    entry.read,
    entry.starred,
    entry.updatedAt,
    toBulkUnreadCounts(counts)
  ).catch(() => {
    // Ignore publish errors - SSE is best-effort
  });
}
