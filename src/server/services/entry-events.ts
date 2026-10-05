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
import { feeds, subscriptions, visibleEntries } from "@/server/db/schema";
import { entryFeedTitleSql } from "@/server/services/entry-filters";
import { entryListPayload } from "@/server/services/entry-sync-events";
import type { BulkUnreadCounts } from "@/server/services/counts";
import type { MarkReadEntryState } from "@/server/services/entries";

/**
 * Fetches the list-item context for entries that flipped to unread, keyed by
 * entry id, so their entry_state_changed events can carry an insertable
 * payload (issue #1237), which spam doesn't get (see `entryListPayload`).
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
      feedType: visibleEntries.type,
      url: visibleEntries.url,
      title: visibleEntries.title,
      author: visibleEntries.author,
      summary: visibleEntries.summary,
      publishedAt: visibleEntries.publishedAt,
      fetchedAt: visibleEntries.fetchedAt,
      siteName: visibleEntries.siteName,
      isSpam: visibleEntries.isSpam,
      feedTitle: entryFeedTitleSql(),
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(feeds.id, visibleEntries.feedId))
    .leftJoin(subscriptions, eq(subscriptions.id, visibleEntries.subscriptionId))
    .where(and(eq(visibleEntries.userId, userId), inArray(visibleEntries.id, entryIds)));

  const result = new Map<string, EntryStateListData>();
  for (const row of rows) {
    const entry = entryListPayload(row, row.feedTitle);
    if (!entry) continue;
    result.set(row.id, {
      subscriptionId: row.subscriptionId,
      feedType: row.feedType,
      entry,
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
 * Publishes an entry_state_changed event for each entry affected by a bulk
 * star/unstar, carrying the absolute counts so other tabs set them directly.
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
