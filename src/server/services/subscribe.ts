/**
 * Subscribing to a web feed: by URL, by known feed, and moving subscriptions
 * onto the existing feed a permanent redirect points at. Each gives the
 * subscriber the feed's current entries ("Entry Visibility" in
 * `src/server/CLAUDE.md`).
 */

import { eq, and, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { db as dbType, DbOrTx } from "@/server/db";
import { feeds, subscriptions, subscriptionTags, type Feed } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import { ensureFeedJob, scheduleFeedRefreshNow } from "@/server/jobs/queue";
import { shouldRefetchOnSubscribe } from "@/server/feed/scheduling";
import { feedDefaultsToFullContent, getFeedHooks } from "@/server/plugins";
import { publishUserEvent } from "@/server/redis/pubsub";
import {
  subscriptionCreatedEvent,
  subscriptionUpdatedEvent,
} from "@/server/services/subscription-sync-events";
import { getBulkEntryRelatedCounts, type BulkUnreadCounts } from "@/server/services/counts";
import {
  holdsRedirectTwin,
  insertUserEntriesWithMemberships,
} from "@/server/services/subscription-entries";
import {
  getSubscription,
  lockAndCountActiveSubscriptions,
  lockSubscriptionMembers,
  type Subscription,
} from "@/server/services/subscriptions";
import { errors } from "@/server/errors";
import { fetchUrl, isHtmlContent } from "@/server/http/fetch";
import { parseFeedAsync } from "@/server/feed/parser";
import { discoverFeeds } from "@/server/feed/discovery";
import { currentEntryIdsSql } from "@/server/feed/entry-processor";

/**
 * Gives a new or reactivated subscriber the entries currently in the feed
 * ("Entry Visibility" in `src/server/CLAUDE.md`). Only for a fresh feed: a
 * stale feed's cached entries may include ones the publisher has since removed,
 * so callers schedule a forced refresh (`scheduleFeedRefreshNow`) instead, whose
 * fanout populates the subscriber from ground truth.
 */
async function populateInitialUserEntries(
  tx: DbOrTx,
  userId: string,
  subscriptionId: string,
  feedId: string
): Promise<void> {
  // The feed's poll state is read inside the INSERT, not
  // passed in: a feed fetch completing after the caller read the feed bumps it,
  // so a stale captured value would match zero rows and the new subscriber
  // would see an empty feed until the next new entry (issue #952).
  //
  // `currentEntryIdsSql` grants the entries the last poll that stamped the feed
  // saw, plus those a WebSub hub announced since the last poll.
  //
  // Granted unread, however old: everything is news to a new subscriber
  // ("Backfill Guard" in `src/server/feed/CLAUDE.md`).
  //
  // Skips an entry whose twin from another feed the subscription already
  // holds, as the fetch-time fanout does (`holdsRedirectTwin`): a redirect
  // merge copies the old feed's entries into the subscription, and the new
  // feed usually republishes the same articles.
  await insertUserEntriesWithMemberships(
    tx,
    sql`
      SELECT ${subscriptionId}::uuid AS subscription_id, ${userId}::uuid AS user_id, e.id AS entry_id,
             COALESCE(e.published_at, e.fetched_at) AS published_or_fetched_at,
             e.is_spam, false AS read
      FROM entries e
      WHERE e.id IN (${currentEntryIdsSql(feedId, {
        lastEntriesUpdatedAt: sql`(SELECT last_entries_updated_at FROM feeds WHERE id = ${feedId}::uuid)`,
        lastFetchedAt: sql`(SELECT last_fetched_at FROM feeds WHERE id = ${feedId}::uuid)`,
      })})
        AND NOT ${holdsRedirectTwin(sql`${subscriptionId}::uuid`, "e")}
    `
  );
}

// ============================================================================
// Subscription Creation
// ============================================================================

/**
 * Feed data for creating a subscription. For existing feeds, only `url` is required.
 * Other fields are used when creating new feed records.
 */
export interface CreateSubscriptionFeedInput {
  url: string;
  title?: string | null;
  description?: string | null;
  siteUrl?: string | null;
}

/**
 * Result of creating a subscription.
 */
export interface CreateSubscriptionResult {
  subscription: Subscription;
  /** True if the subscription already existed and was active (idempotent return) */
  alreadyActive: boolean;
  /**
   * Absolute unread counts for the lists affected by this subscription (All
   * Articles, Uncategorized, and the subscription itself). Present only when a
   * subscription was actually created or reactivated; omitted for the
   * idempotent already-active return (nothing changed).
   */
  counts?: BulkUnreadCounts;
}

/**
 * Options for {@link createSubscription}.
 */
export interface CreateSubscriptionOptions {
  /**
   * Skip the synchronous initial `user_entries` populate. The interactive
   * subscribe path sets this when it has determined the feed is **stale** and is
   * scheduling an immediate forced background refresh (`scheduleFeedRefreshNow`)
   * instead: for a stale feed we can't know which entries are actually current
   * without re-fetching, so populating from the cached entries could grant a new
   * subscriber an entry the publisher has since removed. The forced fetch's
   * fanout (`createUserEntriesForFeed`) populates the subscriber from ground
   * truth a moment later, exactly as a brand-new feed's first fetch does.
   */
  skipInitialPopulate?: boolean;
}

/**
 * Creates a new subscription to a feed. Handles the full flow:
 * 1. Upserts the feed record (creates if new, uses existing otherwise)
 * 2. Ensures a background fetch job exists for the feed
 * 3. Checks subscription cap (with idempotent return if already subscribed)
 * 4. Upserts the subscription (creates new or reactivates soft-deleted)
 * 5. Populates initial user_entries so the user sees current feed content
 *    (unless `skipInitialPopulate` — see {@link CreateSubscriptionOptions})
 *
 * Idempotent: if the user already has an active subscription, returns it.
 */
export async function createSubscription(
  db: typeof dbType,
  userId: string,
  feed: CreateSubscriptionFeedInput,
  options: CreateSubscriptionOptions = {}
): Promise<CreateSubscriptionResult> {
  const { skipInitialPopulate = false } = options;
  // 1. Upsert feed — insert if new, otherwise use existing
  const newFeedId = generateUuidv7();
  const now = new Date();
  await db
    .insert(feeds)
    .values({
      id: newFeedId,
      url: feed.url,
      title: feed.title ?? null,
      description: feed.description ?? null,
      siteUrl: feed.siteUrl ?? null,
      nextFetchAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: feeds.url });

  const [feedRecord] = await db
    .select({ id: feeds.id })
    .from(feeds)
    .where(eq(feeds.url, feed.url))
    .limit(1);
  if (!feedRecord) {
    throw new Error(`Feed disappeared after upsert: ${feed.url}`);
  }

  const feedId = feedRecord.id;

  // 2. Ensure background fetch job exists
  await ensureFeedJob(feedId);

  // A plugin may opt a source into full-content-by-default (e.g. Bluesky, whose
  // RSS drops embedded content). Applied only to a fresh subscribe below; a
  // resubscribe keeps the user's stored preference.
  const defaultFullContent = feedDefaultsToFullContent(feed.url);

  // 3–5. Cap check + subscription upsert + user_entries populate, all in ONE
  //       transaction, so a crash can't leave a half-created subscription;
  //       lockAndCountActiveSubscriptions serializes the cap check (#952).
  const maxSubs = usageLimitsConfig.maxSubscriptionsPerUser;

  // The row is read inside the transaction, so a concurrent unsubscribe can't
  // make a subscribe that went through report "not found".
  interface TxResult {
    kind: "alreadyActive" | "created";
    subscription: Subscription;
  }

  const txResult: TxResult = await db.transaction(async (tx) => {
    const selectActiveSubscription = () =>
      tx
        .select({ subscriptionId: subscriptions.id })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.userId, userId),
            eq(subscriptions.feedId, feedId),
            isNull(subscriptions.unsubscribedAt)
          )
        )
        .limit(1);

    // 3. Check subscription cap; if at cap, return existing or throw
    const activeCount = await lockAndCountActiveSubscriptions(tx, userId);
    // Reactivating moves the members' rows, which come first in the lock order.
    await lockSubscriptionMembers(
      tx,
      userId,
      and(eq(subscriptions.feedId, feedId), isNotNull(subscriptions.unsubscribedAt))
    );

    if (activeCount >= maxSubs) {
      // Over cap — check if we're already subscribed to this specific feed
      const [existingSub] = await selectActiveSubscription();
      if (existingSub) {
        return {
          kind: "alreadyActive",
          subscription: await getSubscription(tx, userId, existingSub.subscriptionId),
        };
      }

      throw errors.maxSubscriptionsReached(maxSubs);
    }

    // 4. Upsert subscription — insert new or reactivate soft-deleted
    //    RETURNING tells us if the row was actually inserted/updated.
    //    If the subscription is already active, the WHERE clause doesn't match,
    //    so neither insert nor update happens and RETURNING returns nothing.
    const newSubscriptionId = generateUuidv7();
    const subscribedAt = new Date();

    const upsertResult = await tx.execute<{ id: string }>(sql`
      INSERT INTO subscriptions (id, user_id, feed_id, type, subscribed_at, created_at, updated_at, fetch_full_content)
      VALUES (${newSubscriptionId}, ${userId}, ${feedId}, 'web', ${subscribedAt}, ${subscribedAt}, ${subscribedAt}, ${defaultFullContent})
      ON CONFLICT (user_id, feed_id) DO UPDATE SET
        unsubscribed_at = NULL,
        subscribed_at = ${subscribedAt},
        updated_at = ${subscribedAt}
      WHERE subscriptions.unsubscribed_at IS NOT NULL
      RETURNING id
    `);

    if (upsertResult.rows.length === 0) {
      // Subscription was already active — idempotent return. The ON CONFLICT
      // row lock keeps it active for this transaction.
      const [sub] = await selectActiveSubscription();
      if (!sub) {
        throw new Error("Active subscription vanished after upsert conflict");
      }
      return {
        kind: "alreadyActive",
        subscription: await getSubscription(tx, userId, sub.subscriptionId),
      };
    }

    const subscriptionId = upsertResult.rows[0].id;

    // 5. Populate user_entries (skipped for a stale feed; see
    //    CreateSubscriptionOptions).
    if (!skipInitialPopulate) {
      await populateInitialUserEntries(tx, userId, subscriptionId, feedId);
    }

    return { kind: "created", subscription: await getSubscription(tx, userId, subscriptionId) };
  });

  const { subscription } = txResult;
  if (txResult.kind === "alreadyActive") {
    return { subscription, alreadyActive: true };
  }

  // 7. Compute absolute unread counts for the affected lists: All Articles,
  // Uncategorized (unsubscribing cleared a reactivated subscription's tags)
  // and its own. The client sets these directly.
  const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: subscription.id }]);

  logger.debug("Populated initial user entries via lastSeenAt", {
    userId,
    feedId,
    entryCount: subscription.unreadCount,
  });

  // 8. Publish SSE event for new/reactivated subscriptions
  publishUserEvent({
    ...subscriptionCreatedEvent(subscription),
    userId,
    feedId,
    updatedAt: subscription.subscribedAt,
    counts,
  });

  return { subscription, alreadyActive: false, counts };
}

/**
 * Fetch a URL, discover feeds if HTML, parse the feed content,
 * and return metadata for subscription creation.
 */
async function fetchAndResolveFeed(inputUrl: string): Promise<CreateSubscriptionFeedInput> {
  const { text: content, contentType, finalUrl: initialFinalUrl } = await fetchUrl(inputUrl);

  let feedContent: string;
  let finalFeedUrl: string;

  if (isHtmlContent(contentType, content)) {
    const discoveredFeeds = discoverFeeds(content, initialFinalUrl);
    if (discoveredFeeds.length === 0) {
      throw errors.validation("No feeds found at this URL");
    }

    const discoveredFetch = await fetchUrl(discoveredFeeds[0].url);
    feedContent = discoveredFetch.text;
    finalFeedUrl = discoveredFetch.finalUrl;
  } else {
    feedContent = content;
    finalFeedUrl = initialFinalUrl;
  }

  let parsedFeed;
  try {
    parsedFeed = await parseFeedAsync(feedContent);
  } catch {
    throw errors.validation("Could not parse feed - make sure it's a valid RSS or Atom feed");
  }

  return {
    url: finalFeedUrl,
    title: getFeedHooks(finalFeedUrl).resolveFeedTitle(parsedFeed),
    description: parsedFeed.description || null,
    siteUrl: parsedFeed.siteUrl || null,
  };
}

/**
 * Subscribes the user to the feed at a URL the user gave us, which may be an
 * HTML page that advertises its feed. Every surface that subscribes by URL
 * (tRPC, Google Reader `quickadd`) goes through here, so they all validate the
 * feed, schedule its fetch and notify open clients the same way.
 */
export async function subscribeToUrl(
  db: typeof dbType,
  userId: string,
  feedUrl: string
): Promise<CreateSubscriptionResult> {
  const [existing] = await db
    .select({
      id: feeds.id,
      lastFetchedAt: feeds.lastFetchedAt,
      staleAt: feeds.staleAt,
    })
    .from(feeds)
    .where(eq(feeds.url, feedUrl))
    .limit(1);

  // A feed we've never fetched successfully (brand new, or a raw URL from an
  // OPML import that may really be an HTML page) is fetched and parsed here to
  // resolve the real feed URL and its metadata; its entries come from the
  // background fetch job, so it needs no forced refresh. An unreachable or
  // unparseable URL fails the subscribe.
  if (!existing || existing.lastFetchedAt === null) {
    return createSubscription(db, userId, await fetchAndResolveFeed(feedUrl));
  }

  // A known feed's cached entries may be stale (past its own poll cadence), and
  // we can't know the current set without re-fetching. Rather than fetch on the request path,
  // skip the synchronous populate and force a background refresh, whose fanout
  // populates this subscriber from ground truth, excluding anything the
  // publisher has since removed (#1078).
  const stale = shouldRefetchOnSubscribe(existing);
  const result = await createSubscription(
    db,
    userId,
    { url: feedUrl },
    {
      skipInitialPopulate: stale,
    }
  );
  // The job queue is single-flight per feed, so concurrent subscribes coalesce
  // into one fetch. An already-active subscription has nothing to populate.
  if (stale && !result.alreadyActive) {
    await scheduleFeedRefreshNow(existing.id);
  }
  return result;
}

/**
 * Moves one of the user's subscriptions onto another feed, for a permanent
 * redirect onto a feed that already exists. The user ends up actively
 * subscribed to `newFeed` (the "survivor": their existing subscription to it,
 * reactivated or created as needed) with the old subscription's tags, and the
 * old feed's entries re-attributed to it, so read/starred state carries over.
 * A survivor that wasn't already active also takes the old subscription's
 * title and full-content setting, and gets the feed's current entries like a
 * fresh subscribe (a stale feed gets a forced refresh instead).
 *
 * There's no subscription cap check: a merge never raises the user's number of
 * active subscriptions. Returns false if the old subscription is no longer
 * active.
 */
export async function mergeSubscriptionIntoFeed(
  db: typeof dbType,
  userId: string,
  oldSubscriptionId: string,
  newFeed: Feed
): Promise<boolean> {
  const populate = !shouldRefetchOnSubscribe(newFeed);
  const defaultFullContent = newFeed.url !== null && feedDefaultsToFullContent(newFeed.url);
  const now = new Date();

  const merged = await db.transaction(async (tx) => {
    // Lock order: the user_entries rows the re-stamp moves and the
    // (de)activations change (both subscriptions' members), then the
    // subscription rows (see "Unread Counts" in src/server/CLAUDE.md).
    await lockSubscriptionMembers(
      tx,
      userId,
      or(eq(subscriptions.id, oldSubscriptionId), eq(subscriptions.feedId, newFeed.id))
    );

    const [old] = await tx
      .select({
        feedId: subscriptions.feedId,
        customTitle: subscriptions.customTitle,
        fetchFullContent: subscriptions.fetchFullContent,
      })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.id, oldSubscriptionId),
          eq(subscriptions.userId, userId),
          isNull(subscriptions.unsubscribedAt)
        )
      )
      .for("update");
    if (!old) {
      return null;
    }

    // Insert or reactivate the survivor. An already-active survivor keeps its
    // own settings; the ON CONFLICT row lock holds it for this transaction.
    const upserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO subscriptions (id, user_id, feed_id, type, subscribed_at, created_at, updated_at, custom_title, fetch_full_content)
      VALUES (${generateUuidv7()}, ${userId}, ${newFeed.id}, 'web', ${now}, ${now}, ${now}, ${old.customTitle}, ${old.fetchFullContent || defaultFullContent})
      ON CONFLICT (user_id, feed_id) DO UPDATE SET
        unsubscribed_at = NULL,
        subscribed_at = EXCLUDED.subscribed_at,
        updated_at = EXCLUDED.updated_at,
        custom_title = EXCLUDED.custom_title,
        fetch_full_content = EXCLUDED.fetch_full_content
      WHERE subscriptions.unsubscribed_at IS NOT NULL
      RETURNING id
    `);
    const survivorWasActive = upserted.rows.length === 0;
    const [survivor] = await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, newFeed.id)));

    // The survivor takes the old subscription's articles; the old one keeps
    // them, unsubscribed. Deliberately leaves user_entries.updated_at alone:
    // the articles stay visible, and bumping it would flood the user's delta
    // sync.
    await tx.execute(sql`
      INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at,
                                        read, starred, is_spam)
      SELECT ${survivor.id}::uuid, user_id, entry_id, published_or_fetched_at, read, starred, is_spam
      FROM subscription_entries
      WHERE subscription_id = ${oldSubscriptionId}
      ON CONFLICT DO NOTHING
    `);

    // An already-active survivor's tags before it takes the old one's: its
    // former lists (Uncategorized, if none) change too.
    let survivorFormerTagIds: string[] | null = null;
    if (survivorWasActive) {
      const rows = await tx
        .select({ tagId: subscriptionTags.tagId })
        .from(subscriptionTags)
        .where(eq(subscriptionTags.subscriptionId, survivor.id));
      survivorFormerTagIds = rows.map(({ tagId }) => tagId);
    } else {
      // Tags left on an inactive subscription are stale (unsubscribing clears them).
      await tx.delete(subscriptionTags).where(eq(subscriptionTags.subscriptionId, survivor.id));
      // After the copy, so the populate's GUID check sees the old feed's entries.
      if (populate) {
        await populateInitialUserEntries(tx, userId, survivor.id, newFeed.id);
      }
    }

    const movedTags = await tx
      .delete(subscriptionTags)
      .where(eq(subscriptionTags.subscriptionId, oldSubscriptionId))
      .returning({ tagId: subscriptionTags.tagId });
    const addedTags =
      movedTags.length === 0
        ? []
        : await tx
            .insert(subscriptionTags)
            .values(movedTags.map(({ tagId }) => ({ subscriptionId: survivor.id, tagId })))
            .onConflictDoNothing()
            .returning({ tagId: subscriptionTags.tagId });
    if (survivorWasActive && addedTags.length > 0) {
      await tx
        .update(subscriptions)
        .set({ updatedAt: now })
        .where(eq(subscriptions.id, survivor.id));
    }

    await tx
      .update(subscriptions)
      .set({ unsubscribedAt: now, updatedAt: now })
      .where(eq(subscriptions.id, oldSubscriptionId));

    return {
      oldFeedId: old.feedId,
      formerTagIds: [
        movedTags.map(({ tagId }) => tagId),
        ...(survivorFormerTagIds ? [survivorFormerTagIds] : []),
      ],
      survivor: await getSubscription(tx, userId, survivor.id),
      survivorWasActive,
      survivorTagsChanged: addedTags.length > 0,
    };
  });

  if (!merged) {
    return false;
  }
  const { oldFeedId, formerTagIds, survivor, survivorWasActive } = merged;

  // Unconditional, not just for a new survivor: retention deletes the job of a
  // feed with no active subscriber, so a merge can be what brings the feed back.
  if (!survivorWasActive && !populate) {
    await scheduleFeedRefreshNow(newFeed.id);
  } else {
    await ensureFeedJob(newFeed.id);
  }

  const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: survivor.id }], {
    formerTagIds,
  });
  publishUserEvent({
    type: "subscription_deleted",
    userId,
    feedId: oldFeedId,
    subscriptionId: oldSubscriptionId,
    updatedAt: now,
    counts,
  });
  if (!survivorWasActive) {
    publishUserEvent({
      ...subscriptionCreatedEvent(survivor),
      userId,
      feedId: newFeed.id,
      updatedAt: now,
      counts,
    });
  } else if (merged.survivorTagsChanged) {
    publishUserEvent({
      ...subscriptionUpdatedEvent(survivor),
      userId,
      updatedAt: now,
    });
  }

  return true;
}

/**
 * Moves every active subscription on `oldFeed` onto `newFeed`, the existing
 * feed at its permanent redirect target. The old feed's job stops being claimed
 * once it has no active subscribers.
 */
export async function migrateSubscriptionsToExistingFeed(
  db: typeof dbType,
  oldFeed: Feed,
  newFeed: Feed
): Promise<void> {
  const activeSubscriptions = await db
    .select({ userId: subscriptions.userId, id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.feedId, oldFeed.id), isNull(subscriptions.unsubscribedAt)));

  logger.info("Migrating subscriptions to existing feed", {
    oldFeedId: oldFeed.id,
    newFeedId: newFeed.id,
    subscriptionCount: activeSubscriptions.length,
  });

  for (const { userId, id } of activeSubscriptions) {
    await mergeSubscriptionIntoFeed(db, userId, id, newFeed);
  }
}
