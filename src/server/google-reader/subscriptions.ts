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

import { eq, sql } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { users } from "@/server/db/schema";
import * as subscriptionsService from "@/server/services/subscriptions";
import type { ListEntriesParams } from "@/server/services/entries";
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
 * Unread counts are trigger-maintained counters (issue #1117, step 5b) — a
 * free column read per subscription plus one users-row read for the saved
 * feed — so the old `includeUnreadCounts` opt-out (issue #1074) is gone; every
 * caller gets real counts. Spam never counts (the counters exclude it).
 */
export async function listGreaderSubscriptions(
  db: typeof dbType,
  userId: string
): Promise<subscriptionsService.Subscription[]> {
  const [all, saved] = await Promise.all([
    subscriptionsService.listAllSubscriptions(db, userId),
    getSavedSubscription(db, userId),
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
  userId: string
): Promise<subscriptionsService.Subscription | null> {
  const feedId = await getSavedFeedId(db, userId);
  if (!feedId) return null;

  // The saved badge is the trigger-maintained users.saved_unread_count
  // counter (migration 0092) — a single-row read, so there's no wasted work
  // for callers that ignore counts (the issue #1074 opt-out is moot).
  const [row] = await db
    .select({ unread: users.savedUnreadCount })
    .from(users)
    .where(eq(users.id, userId));
  const unread = row?.unread ?? 0;

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
 * Per-feed unread count and newest visible item time for the Google Reader
 * unread-count endpoint, both keyed by the id `formatUnreadCounts` emits: the real
 * subscription id, or the saved feed's id for the synthetic saved feed (issue
 * #730). Returned as the `{ subscriptions, newestItemAtById }` pair that endpoint
 * feeds straight into `formatUnreadCounts`.
 *
 * The two used to be separate reads (subscription counts + a per-feed newest map),
 * which opened a benign TOCTOU: a feed gaining its first visible entry between the
 * reads could be counted (unread > 0) yet be absent from the newest map (issue
 * #1092). They're now derived from a **single statement**, so both come from one
 * snapshot and the race is structurally impossible — no transaction needed. This
 * became clean once the unread count was a trigger-maintained counter column
 * (`subscriptions.unread_count` / `users.saved_unread_count`, issue #1117): the
 * count is a free column read here, identical to what `user_feeds` exposes (the
 * view selects the same column, filtered by the same `unsubscribed_at IS NULL`),
 * so there's no spam/visibility logic duplicated from `buildSubscriptionBaseQuery`.
 *
 * "Newest visible" is the most recent entry — by `COALESCE(published_at,
 * fetched_at)`, matching stream ordering — that the user has a `user_entries` row
 * for (the same record `visible_entries` treats as visibility). Read state is
 * ignored (a read article is still the stream's newest item) and spam is included,
 * so a feed with an unread item always has a newest. It's a per-subscription seek:
 * a LATERAL `LIMIT 1` over `user_entries` reads the newest attributed row straight
 * off `idx_user_entries_subscription_timeline` (subscription_id,
 * published_or_fetched_at DESC, entry_id DESC — migration 0088). The saved feed
 * has no subscription row, so its arm looks up newest by feed id directly and its
 * count from `users.saved_unread_count`. Cost is O(subscriptions) index seeks.
 */
export async function getGreaderUnreadCounts(
  db: typeof dbType,
  userId: string
): Promise<{
  subscriptions: Array<{ id: string; unreadCount: number }>;
  newestItemAtById: Map<string, Date>;
}> {
  const result = await db.execute(sql`
    SELECT s.id AS stream_id, s.unread_count AS unread, latest.newest AS newest
    FROM subscriptions s
    LEFT JOIN LATERAL (
      SELECT ue.published_or_fetched_at AS newest
      FROM user_entries ue
      WHERE ue.subscription_id = s.id
      ORDER BY ue.published_or_fetched_at DESC, ue.entry_id DESC
      LIMIT 1
    ) latest ON true
    WHERE s.user_id = ${userId}::uuid
      AND s.unsubscribed_at IS NULL

    UNION ALL

    SELECT f.id AS stream_id, u.saved_unread_count AS unread, latest.newest AS newest
    FROM feeds f
    JOIN users u ON u.id = f.user_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(e.published_at, e.fetched_at) AS newest
      FROM entries e
      JOIN user_entries ue ON ue.user_id = f.user_id AND ue.entry_id = e.id
      WHERE e.feed_id = f.id
      ORDER BY COALESCE(e.published_at, e.fetched_at) DESC, e.id DESC
      LIMIT 1
    ) latest ON true
    WHERE f.type = 'saved' AND f.user_id = ${userId}::uuid
  `);

  const subscriptions: Array<{ id: string; unreadCount: number }> = [];
  const newestItemAtById = new Map<string, Date>();
  for (const row of result.rows as Array<{
    stream_id: string;
    unread: number;
    newest: Date | null;
  }>) {
    subscriptions.push({ id: row.stream_id, unreadCount: row.unread });
    if (row.newest) newestItemAtById.set(row.stream_id, new Date(row.newest));
  }

  return { subscriptions, newestItemAtById };
}
