/**
 * Google Reader subscription enumeration & feed-stream resolution.
 *
 * The per-user saved-articles feed is exposed to Google Reader clients as a
 * synthetic, uncategorized "Saved Articles" subscription (issue #730). It has no
 * real subscription row, so every endpoint that lists subscriptions or resolves a
 * `feed/{int64}` stream has to account for it. Rather than re-deriving that
 * special case in each route handler — which is how mark-all-as-read once ended
 * up silently no-op'ing on the saved feed (issue #1069) — the handlers go through
 * the helpers here, so the saved feed is materialized in exactly one place.
 */

import { sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import * as subscriptionsService from "@/server/services/subscriptions";
import { countEntries, type ListEntriesParams } from "@/server/services/entries";
import { getSavedFeedId, SAVED_FEED_TITLE } from "@/server/feed/saved-feed";
import { resolveFeedStream } from "./id";

/**
 * An entries-service feed filter fragment. Both `listEntries` and
 * `markAllEntriesRead` accept `type`/`subscriptionId`, so a resolved feed stream
 * spreads straight into either param object.
 *
 * The member types are derived from `ListEntriesParams` (both services share
 * these key names) so a rename or retype of `type`/`subscriptionId` in the
 * service fails typecheck here instead of silently letting the `Object.assign`
 * spread at the call sites drop the filter.
 */
export type GreaderFeedFilter =
  | { type: Extract<NonNullable<ListEntriesParams["type"]>, "saved"> }
  | { subscriptionId: NonNullable<ListEntriesParams["subscriptionId"]> };

/**
 * Resolves a `feed/{int64}` stream to the entries-service filter that selects its
 * entries: a real subscription id, or the `type: "saved"` filter for the
 * saved-articles feed (which has no subscription row — issue #730). Returns null
 * when the int64 matches nothing the user owns.
 *
 * This is the single place a Google Reader feed stream becomes a service filter,
 * so stream/contents, stream/items/ids, and mark-all-as-read all treat the
 * synthetic saved feed identically.
 */
export async function resolveFeedStreamFilter(
  db: typeof dbType,
  userId: string,
  streamInt64: bigint
): Promise<GreaderFeedFilter | null> {
  const resolved = await resolveFeedStream(db, userId, streamInt64);
  if (!resolved) return null;
  return resolved.kind === "saved"
    ? { type: "saved" }
    : { subscriptionId: resolved.subscriptionId };
}

/**
 * Enumerates every subscription a Google Reader client should see, with the
 * per-user saved-articles feed appended as a synthetic subscription (issue #730).
 * Google Reader has no pagination on the wire, so the real subscriptions are
 * fetched in a single unbounded query (`listAllSubscriptions`) rather than a
 * cursor loop, concurrently with the saved-feed lookup.
 *
 * Centralizing the saved-feed append here means subscription/list and
 * unread-count inherit it for free instead of each re-deriving it (issue #1069).
 *
 * `includeUnreadCounts: false` (issue #1074) skips both the per-subscription
 * unread aggregate and the saved feed's `countEntries`, returning every
 * `unreadCount` as 0 — for callers like subscription/list that never emit
 * counts. unread-count keeps the default.
 */
export async function listGreaderSubscriptions(
  db: typeof dbType,
  userId: string,
  opts: { showSpam: boolean; includeUnreadCounts?: boolean }
): Promise<subscriptionsService.Subscription[]> {
  const [all, saved] = await Promise.all([
    subscriptionsService.listAllSubscriptions(db, userId, {
      includeUnreadCounts: opts.includeUnreadCounts,
    }),
    getSavedSubscription(db, userId, opts),
  ]);

  return saved ? [...all, saved] : all;
}

/**
 * The saved-articles feed as a synthetic `Subscription`, or null if the user has
 * no saved feed yet (a user who has never saved anything gets no empty feed). It
 * carries its unread count and enough metadata to be formatted and counted
 * exactly like a real subscription (uncategorized, titled "Saved Articles"), so
 * downstream formatting needs no saved special case. `subscribedAt` is the epoch
 * — the saved feed has no meaningful subscription time.
 *
 * Module-private: routes go through `listGreaderSubscriptions` so the saved feed
 * is appended in exactly one place (issue #1069).
 */
async function getSavedSubscription(
  db: typeof dbType,
  userId: string,
  opts: { showSpam: boolean; includeUnreadCounts?: boolean }
): Promise<subscriptionsService.Subscription | null> {
  const feedId = await getSavedFeedId(db, userId);
  if (!feedId) return null;

  const unread =
    (opts.includeUnreadCounts ?? true)
      ? (await countEntries(db, userId, { type: "saved", showSpam: opts.showSpam })).unread
      : 0;

  return {
    id: feedId,
    type: "saved",
    url: null,
    title: SAVED_FEED_TITLE,
    originalTitle: SAVED_FEED_TITLE,
    description: null,
    siteUrl: null,
    subscribedAt: new Date(0),
    unreadCount: unread,
    tags: [],
    fetchFullContent: false,
  };
}

/**
 * Newest visible item time per Google Reader feed stream, for the unread-count
 * endpoint's `newestItemTimestampUsec`. Keyed by the id `formatUnreadCounts`
 * emits: the real subscription id, or the saved feed's id for the synthetic saved
 * feed (issue #730). Feeds with no visible entries are simply absent from the map.
 *
 * "Newest visible" is the most recent entry — by `COALESCE(published_at,
 * fetched_at)`, matching stream ordering — that the user has a `user_entries` row
 * for (the same record the `visible_entries` view treats as visibility). Read
 * state is ignored (a read article is still the stream's newest item) and spam is
 * included, so this stays consistent with the unread counts and never yields null
 * for a feed that has an unread item.
 *
 * Shaped as a per-feed short-circuit: for each subscribed feed, walk entries
 * newest-first on `idx_entries_feed_published_coalesce` and stop at the first one
 * the user has (probing the `user_entries` primary key). Because the fanout
 * invariant guarantees an active subscriber has the feed's newest entries, the
 * `LIMIT 1` hits immediately, so the cost is O(subscriptions), not O(entry
 * history). Verified index-only and sub-millisecond with EXPLAIN — it rides
 * existing indexes, so no new index is needed.
 */
export async function getGreaderNewestItemAt(
  db: typeof dbType,
  userId: string
): Promise<Map<string, Date>> {
  const [realResult, savedFeedId] = await Promise.all([
    db.execute(sql`
      SELECT sf.subscription_id AS subscription_id, max(latest.newest) AS newest
      FROM subscription_feeds sf
      JOIN subscriptions s ON s.id = sf.subscription_id AND s.unsubscribed_at IS NULL
      JOIN LATERAL (
        SELECT COALESCE(e.published_at, e.fetched_at) AS newest
        FROM entries e
        JOIN user_entries ue ON ue.user_id = sf.user_id AND ue.entry_id = e.id
        WHERE e.feed_id = sf.feed_id
        ORDER BY COALESCE(e.published_at, e.fetched_at) DESC, e.id DESC
        LIMIT 1
      ) latest ON true
      WHERE sf.user_id = ${userId}::uuid
      GROUP BY sf.subscription_id
    `),
    getSavedFeedId(db, userId),
  ]);

  const newestById = new Map<string, Date>();
  for (const row of realResult.rows as Array<{ subscription_id: string; newest: Date | null }>) {
    if (row.newest) newestById.set(row.subscription_id, new Date(row.newest));
  }

  // The saved feed has no subscription_feeds row, so its newest is looked up by
  // its feed id directly (same per-feed short-circuit as above).
  if (savedFeedId) {
    const savedResult = await db.execute(sql`
      SELECT COALESCE(e.published_at, e.fetched_at) AS newest
      FROM entries e
      JOIN user_entries ue ON ue.user_id = ${userId}::uuid AND ue.entry_id = e.id
      WHERE e.feed_id = ${savedFeedId}::uuid
      ORDER BY COALESCE(e.published_at, e.fetched_at) DESC, e.id DESC
      LIMIT 1
    `);
    const newest = (savedResult.rows[0] as { newest: Date | null } | undefined)?.newest;
    if (newest) newestById.set(savedFeedId, new Date(newest));
  }

  return newestById;
}
