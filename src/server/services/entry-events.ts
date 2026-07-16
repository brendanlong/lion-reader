/**
 * Entry State Change Events
 *
 * Shared "publish entry_state_changed after a mutation" logic so the tRPC
 * routers and the MCP tools stay in sync. Both surfaces mark entries read and
 * star/unstar via the same services, so both must emit the same SSE events for
 * multi-tab/device sync — extracting this here keeps the mcp-scoped endpoints
 * mirroring the MCP tools exactly (see src/server/auth/CLAUDE.md).
 *
 * All publishing is fire-and-forget: SSE is best-effort and must never block or
 * fail the mutation response.
 */

import { and, eq, inArray } from "drizzle-orm";

import { publishEntryStateChanged, type EntryStateListData } from "@/server/redis/pubsub";
import type { DbOrTx } from "@/server/db";
import { feeds, visibleEntries } from "@/server/db/schema";
import { toNewEntryListData } from "@/lib/events/schemas";
import {
  toBulkUnreadCounts,
  type BulkUnreadCounts,
  type UnreadCounts,
} from "@/server/services/counts";
import type { EntryState, MarkReadEntryState } from "@/server/services/entries";

/**
 * Fetches the list-item context for entries that flipped to unread, keyed by
 * entry id, so their entry_state_changed events can carry an insertable
 * payload (issue #1237). Spam entries are skipped — the default entries.list
 * filters them, so a client-side insert would show a row the server never
 * returns (mirroring the new_entry rule).
 */
async function fetchUnreadListData(
  db: DbOrTx,
  userId: string,
  entryIds: string[]
): Promise<Map<string, EntryStateListData>> {
  const rows = await db
    .select({
      id: visibleEntries.id,
      subscriptionId: visibleEntries.subscriptionId,
      feedId: visibleEntries.feedId,
      feedType: visibleEntries.type,
      url: visibleEntries.url,
      title: visibleEntries.title,
      author: visibleEntries.author,
      summary: visibleEntries.summary,
      publishedAt: visibleEntries.publishedAt,
      fetchedAt: visibleEntries.fetchedAt,
      siteName: visibleEntries.siteName,
      isSpam: visibleEntries.isSpam,
      feedTitle: feeds.title,
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(feeds.id, visibleEntries.feedId))
    .where(and(eq(visibleEntries.userId, userId), inArray(visibleEntries.id, entryIds)));

  const result = new Map<string, EntryStateListData>();
  for (const row of rows) {
    if (row.isSpam) continue;
    result.set(row.id, {
      subscriptionId: row.subscriptionId,
      feedId: row.feedId,
      feedType: row.feedType,
      entry: toNewEntryListData(row, row.feedTitle),
    });
  }
  return result;
}

/**
 * Publishes an entry_state_changed event for each entry affected by a bulk
 * markRead, carrying the absolute counts so other tabs set them directly.
 *
 * Events for entries that flipped to unread also carry the entry's list-item
 * data, so clients can insert it into cached lists it's missing from — the
 * same way new_entry payloads make new entries appear live (issue #1237).
 * The lookup only runs when something flipped to unread (never on the hot
 * mark-read path), and a lookup failure degrades to publishing without the
 * payload (the client falls back to restoring from another cached list).
 */
export function publishMarkReadStateChanges(
  db: DbOrTx,
  userId: string,
  entries: MarkReadEntryState[],
  counts: BulkUnreadCounts
): void {
  void (async () => {
    const unreadIds = entries.filter((entry) => !entry.read).map((entry) => entry.id);
    let listData = new Map<string, EntryStateListData>();
    if (unreadIds.length > 0) {
      try {
        listData = await fetchUnreadListData(db, userId, unreadIds);
      } catch {
        // Publish without payloads - SSE is best-effort
      }
    }
    await Promise.all(
      entries.map((entry) =>
        publishEntryStateChanged(
          userId,
          entry.id,
          entry.read,
          entry.starred,
          entry.updatedAt,
          counts,
          listData.get(entry.id)
        ).catch(() => {
          // Ignore publish errors - SSE is best-effort
        })
      )
    );
  })();
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

/**
 * Publishes an entry_state_changed event for each entry affected by a bulk
 * star/unstar, carrying the absolute counts so other tabs set them directly.
 * Mirrors {@link publishStarredStateChange} but for the batched
 * (`updateEntriesStarred`) path — counts are already array-shaped, so no
 * per-entry normalization is needed.
 */
export function publishStarredStateChanges(
  userId: string,
  entries: Array<Pick<MarkReadEntryState, "id" | "read" | "starred" | "updatedAt">>,
  counts: BulkUnreadCounts
): void {
  void Promise.all(
    entries.map((entry) =>
      publishEntryStateChanged(
        userId,
        entry.id,
        entry.read,
        entry.starred,
        entry.updatedAt,
        counts
      ).catch(() => {
        // Ignore publish errors - SSE is best-effort
      })
    )
  );
}
