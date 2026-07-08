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

import type { db as dbType } from "@/server/db";
import * as subscriptionsService from "@/server/services/subscriptions";
import { countEntries } from "@/server/services/entries";
import { getSavedFeedId, SAVED_FEED_TITLE } from "@/server/feed/saved-feed";
import { resolveFeedStream } from "./id";

/**
 * An entries-service feed filter fragment. Both `listEntries` and
 * `markAllEntriesRead` accept `type`/`subscriptionId`, so a resolved feed stream
 * spreads straight into either param object.
 */
export type GreaderFeedFilter = { type: "saved" } | { subscriptionId: string };

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
 */
export async function listGreaderSubscriptions(
  db: typeof dbType,
  userId: string,
  opts: { showSpam: boolean }
): Promise<subscriptionsService.Subscription[]> {
  const [all, saved] = await Promise.all([
    subscriptionsService.listAllSubscriptions(db, userId),
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
 */
export async function getSavedSubscription(
  db: typeof dbType,
  userId: string,
  opts: { showSpam: boolean }
): Promise<subscriptionsService.Subscription | null> {
  const feedId = await getSavedFeedId(db, userId);
  if (!feedId) return null;

  const { unread } = await countEntries(db, userId, { type: "saved", showSpam: opts.showSpam });

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
