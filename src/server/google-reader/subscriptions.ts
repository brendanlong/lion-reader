/**
 * Google Reader subscription enumeration & feed-stream resolution.
 *
 * The user's saved subscription is exposed to Google Reader clients as an
 * uncategorized "Saved Articles" subscription (issue #730). The app's own
 * subscription lists hide it (#1846), so every endpoint that lists
 * subscriptions or resolves a `feed/{int64}` stream goes through the helpers
 * here, which add it in exactly one place (issue #1069).
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import { isUniqueViolation } from "@/server/db/errors";
import { COLLECTION_NAME_MAX_LENGTH } from "@/lib/collections";
import type { db as dbType } from "@/server/db";
import { subscriptions } from "@/server/db/schema";
import * as subscriptionsService from "@/server/services/subscriptions";
import { getGlobalUnreadCounts } from "@/server/services/counts";
import type { ListEntriesParams } from "@/server/services/entries";
import { resolveFeedStream } from "./id";
import { listGreaderLabels } from "./labels";
import { errorResponse } from "./parse";

/**
 * A subscription plus its Google Reader feed stream serial
 * (`subscriptions.greader_stream_id`). The compat id is kept off the shared `Subscription` type
 * — which flows to the main app and MCP, where a bigint can't be JSON-serialized
 * — and attached only here where the Google Reader layer needs it.
 */
export type GreaderSubscription = subscriptionsService.Subscription & { greaderStreamId: bigint };

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
 * entries: a subscription id, or for the saved subscription the `type: "saved"`
 * filter (Saved, the saved subscription's members; it isn't a subscription
 * filter the app accepts). Returns null when the int64 matches nothing the user
 * owns.
 *
 * This is the single place a Google Reader feed stream becomes a service filter,
 * so stream/contents, stream/items/ids, and mark-all-as-read all treat the
 * saved subscription identically.
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
 * user's saved subscription appended as "Saved Articles" (issue #730).
 * Google Reader has no pagination on the wire, so the real subscriptions are
 * fetched in a single unbounded query (`listAllSubscriptions`) rather than a
 * cursor loop, concurrently with the saved-subscription lookup.
 *
 * Centralizing the saved append here means subscription/list and
 * unread-count inherit it for free instead of each re-deriving it (issue #1069).
 *
 * Unread counts are trigger-maintained counters (issue #1117, step 5b) — a
 * free column read per subscription — so the old `includeUnreadCounts` opt-out (issue #1074) is gone; every
 * caller gets real counts. Spam never counts (the counters exclude it).
 *
 * Collections are left out: they're labels (`labels.ts`).
 */
export async function listGreaderSubscriptions(
  db: typeof dbType,
  userId: string
): Promise<GreaderSubscription[]> {
  // Fetch the subscriptions, their stream serials, and the saved feed together.
  // The stream serial is kept off the shared Subscription type (see
  // GreaderSubscription), so it's read here and zipped on by id.
  const [all, streamIds, saved] = await Promise.all([
    subscriptionsService.listAllSubscriptions(db, userId),
    db
      .select({ id: subscriptions.id, greaderStreamId: subscriptions.greaderStreamId })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          isNull(subscriptions.unsubscribedAt),
          subscriptionsService.isListedSubscription()
        )
      ),
    getSavedSubscription(db, userId),
  ]);

  const streamIdById = new Map(streamIds.map((s) => [s.id, s.greaderStreamId]));
  const withStreamIds: GreaderSubscription[] = all.flatMap((sub) =>
    sub.type === "collection"
      ? []
      : [
          {
            ...sub,
            // Present for every active subscription (both queries filter the same set).
            greaderStreamId: streamIdById.get(sub.id) ?? BigInt(0),
          },
        ]
  );

  return saved ? [...withStreamIds, saved] : withStreamIds;
}

/**
 * Sets a subscription's title, trimmed like the tRPC rename. The IS DISTINCT
 * FROM guard makes a same-title re-save match no row, so updated_at doesn't
 * move and the subscription delta-sync cursor doesn't churn when a client
 * re-asserts the title it already has (#1160). Returns an error response when
 * the subscription is a collection and the name is blank or another of the
 * user's active collections has it, ignoring case (#1846). A blank title for a
 * feed is ignored.
 */
export async function renameGreaderSubscription(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  rawTitle: string
): Promise<Response | null> {
  const title = rawTitle.trim();
  if (!title) {
    return (await subscriptionsService.clearedCustomTitle(db, userId, subscriptionId)) === null
      ? errorResponse("Collection name is required", 400)
      : null;
  }
  if (title.length > COLLECTION_NAME_MAX_LENGTH) {
    return errorResponse(`Titles must be at most ${COLLECTION_NAME_MAX_LENGTH} characters`, 400);
  }
  try {
    await db
      .update(subscriptions)
      .set({ customTitle: title, updatedAt: new Date() })
      .where(
        and(
          eq(subscriptions.id, subscriptionId),
          eq(subscriptions.userId, userId),
          isNull(subscriptions.unsubscribedAt),
          sql`${subscriptions.customTitle} IS DISTINCT FROM ${title}`
        )
      );
    return null;
  } catch (error) {
    if (isUniqueViolation(error)) {
      return errorResponse(`Collection already exists: ${title}`, 409);
    }
    throw error;
  }
}

/**
 * The saved subscription as Google Reader's "Saved Articles" subscription, or
 * null if the user has none yet (a user who has never saved anything gets no
 * empty feed). Formatted and counted exactly like a real subscription
 * (uncategorized, titled "Saved Articles"). `subscribedAt` is the epoch, as it
 * has always been for this stream.
 *
 * Module-private: routes go through `listGreaderSubscriptions` so it is
 * appended in exactly one place (issue #1069).
 */
async function getSavedSubscription(
  db: typeof dbType,
  userId: string
): Promise<GreaderSubscription | null> {
  const [row] = await db
    .select({
      id: subscriptions.id,
      greaderStreamId: subscriptions.greaderStreamId,
      unread: subscriptions.unreadCount,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.type, "saved")))
    .limit(1);
  if (!row) return null;

  return {
    id: row.id,
    greaderStreamId: row.greaderStreamId,
    type: "saved",
    url: null,
    title: subscriptionsService.SAVED_ARTICLES_TITLE,
    originalTitle: subscriptionsService.SAVED_ARTICLES_TITLE,
    description: null,
    siteUrl: null,
    subscribedAt: new Date(0),
    unreadCount: row.unread,
    tags: [],
    fetchFullContent: false,
  };
}

/**
 * Per-feed unread count and newest visible item time for the Google Reader
 * unread-count endpoint, both keyed by the feed stream serial `formatUnreadCounts`
 * emits `feed/{n}` from (`subscriptions.greader_stream_id`, the saved
 * subscription's included), plus the same per label (tags and collections,
 * `labels.ts`). Returned in the shape that endpoint feeds straight into
 * `formatUnreadCounts`.
 *
 * Feed and collection counts and their newest times come from a **single
 * statement**, so one snapshot: a feed gaining its first visible entry between
 * two reads could otherwise be counted (unread > 0) yet be absent from the
 * newest map (issue #1092). The count is the trigger-maintained
 * `subscriptions.unread_count`, the same column `user_feeds` exposes. A tag's
 * count is its own counter (distinct articles), read with the label names; its
 * newest is the newest of its subscriptions'.
 *
 * "Newest visible" is the subscription's newest membership by sort key
 * (`COALESCE(published_at, fetched_at)`, matching stream ordering): read state
 * is ignored (a read article is still the stream's newest item) and spam is
 * included, so a feed with an unread item always has a newest. It's a LATERAL
 * `LIMIT 1` per subscription off `idx_subscription_entries_timeline`, so
 * O(subscriptions) index seeks.
 */
export async function getGreaderUnreadCounts(
  db: typeof dbType,
  userId: string
): Promise<{
  subscriptions: Array<{ streamId: string; unreadCount: number }>;
  newestItemAtByStreamId: Map<string, Date>;
  /** The All badge, for the reading-list total. */
  readingListUnread: number;
  labels: Array<{ name: string; unreadCount: number; newestItemAt: Date | undefined }>;
}> {
  // Keyed by the Google Reader feed stream id, so the result feeds straight
  // into formatUnreadCounts, which emits `feed/{streamId}`. Postgres returns
  // bigint (int8) as a decimal string, which is exactly what the wire id needs.
  const [result, labels, { allUnread }] = await Promise.all([
    db.execute(sql`
      SELECT subscriptions.id,
        ${subscriptionsService.isCollectionSubscription()} AS is_collection,
        subscriptions.greader_stream_id AS stream_id,
        subscriptions.unread_count AS unread,
        latest.newest AS newest,
        ARRAY(
          SELECT st.tag_id::text FROM subscription_tags st
          WHERE st.subscription_id = subscriptions.id
        ) AS tag_ids
      FROM subscriptions
      LEFT JOIN LATERAL (
        SELECT se.published_or_fetched_at AS newest
        FROM subscription_entries se
        WHERE se.subscription_id = subscriptions.id
        ORDER BY se.published_or_fetched_at DESC, se.entry_id DESC
        LIMIT 1
      ) latest ON true
      WHERE subscriptions.user_id = ${userId}::uuid
        AND subscriptions.unsubscribed_at IS NULL
    `),
    listGreaderLabels(db, userId),
    getGlobalUnreadCounts(db, userId),
  ]);

  const subscriptions: Array<{ streamId: string; unreadCount: number }> = [];
  const newestItemAtByStreamId = new Map<string, Date>();
  const collectionCounts = new Map<string, { unreadCount: number; newest: Date | undefined }>();
  const newestByTagId = new Map<string, Date>();
  for (const row of result.rows as Array<{
    id: string;
    is_collection: boolean;
    stream_id: string;
    unread: number;
    newest: Date | null;
    tag_ids: string[];
  }>) {
    const newest = row.newest ? new Date(row.newest) : undefined;
    // Collections are labels, not feeds (see listGreaderSubscriptions).
    if (row.is_collection) {
      collectionCounts.set(row.id, { unreadCount: row.unread, newest });
    } else {
      subscriptions.push({ streamId: row.stream_id, unreadCount: row.unread });
      if (newest) newestItemAtByStreamId.set(row.stream_id, newest);
    }
    if (!newest) continue;
    for (const tagId of row.tag_ids) {
      const prev = newestByTagId.get(tagId);
      if (!prev || newest > prev) newestByTagId.set(tagId, newest);
    }
  }

  return {
    subscriptions,
    newestItemAtByStreamId,
    readingListUnread: allUnread,
    labels: labels.all.map((label) => {
      if (label.kind === "tag") {
        return {
          name: label.name,
          unreadCount: label.unreadCount,
          newestItemAt: newestByTagId.get(label.tagId),
        };
      }
      const counts = collectionCounts.get(label.subscriptionId);
      return {
        name: label.name,
        unreadCount: counts?.unreadCount ?? 0,
        newestItemAt: counts?.newest,
      };
    }),
  };
}
