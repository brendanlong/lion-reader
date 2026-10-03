/**
 * Collections Service (#1806)
 *
 * A collection is a list of articles the user fills by hand (or through an AI
 * assistant). It is stored as a subscription to a per-user feed of type
 * 'collection', so everything that handles subscriptions (tags, renaming,
 * unread counters, the sidebar, deletion) handles collections too. Members are
 * referenced through `collection_entries`, never copied: an article keeps its
 * source feed and its read/starred state.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { db as dbType, Transaction } from "@/server/db";
import {
  collectionEntries,
  feeds,
  subscriptions,
  userEntries,
  visibleEntries,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import { publishCollectionEntriesChanged, publishSubscriptionCreated } from "@/server/redis/pubsub";
import { getBulkEntryRelatedCounts, type BulkUnreadCounts } from "@/server/services/counts";
import {
  lockAndCountActiveSubscriptions,
  type Subscription,
} from "@/server/services/subscriptions";
import { errors } from "@/server/trpc/errors";

/** Most articles one add/remove call may name. */
export const MAX_COLLECTION_BATCH = 1000;

/** The user's collections holding an entry. */
export async function listEntryCollectionIds(
  db: typeof dbType,
  userId: string,
  entryId: string
): Promise<string[]> {
  const rows = await db
    .select({ id: collectionEntries.subscriptionId })
    .from(collectionEntries)
    .where(and(eq(collectionEntries.userId, userId), eq(collectionEntries.entryId, entryId)))
    .orderBy(collectionEntries.subscriptionId);
  return rows.map((row) => row.id);
}

export interface CreateCollectionResult {
  subscription: Subscription;
  counts: BulkUnreadCounts;
}

export async function createCollection(
  db: typeof dbType,
  userId: string,
  name: string
): Promise<CreateCollectionResult> {
  const maxSubs = usageLimitsConfig.maxSubscriptionsPerUser;
  const feedId = generateUuidv7();
  const subscriptionId = generateUuidv7();
  const now = new Date();

  await db.transaction(async (tx) => {
    if ((await lockAndCountActiveSubscriptions(tx, userId)) >= maxSubs) {
      throw errors.maxSubscriptionsReached(maxSubs);
    }
    await tx.insert(feeds).values({
      id: feedId,
      type: "collection",
      userId,
      title: name,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(subscriptions).values({
      id: subscriptionId,
      userId,
      feedId,
      subscribedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });

  const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId }]);
  const feedData = {
    id: feedId,
    type: "collection" as const,
    url: null,
    title: name,
    description: null,
    siteUrl: null,
  };

  publishSubscriptionCreated(
    userId,
    feedId,
    subscriptionId,
    now,
    {
      id: subscriptionId,
      feedId,
      customTitle: null,
      subscribedAt: now.toISOString(),
      unreadCount: 0,
      tags: [],
    },
    feedData,
    counts
  ).catch((err) => {
    logger.error("Failed to publish subscription_created event", { err, userId, feedId });
  });

  return {
    subscription: {
      id: subscriptionId,
      type: "collection",
      url: null,
      title: name,
      originalTitle: name,
      description: null,
      siteUrl: null,
      subscribedAt: now,
      unreadCount: 0,
      tags: [],
      fetchFullContent: false,
    },
    counts,
  };
}

/**
 * Throws unless every id is one of the user's active collections, the only
 * kind of subscription articles can be added to.
 */
export async function assertOwnedCollections(
  db: typeof dbType,
  userId: string,
  subscriptionIds: string[]
): Promise<void> {
  const unique = [...new Set(subscriptionIds)];
  if (unique.length === 0) return;
  const rows = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
    .where(
      and(
        inArray(subscriptions.id, unique),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        eq(feeds.type, "collection")
      )
    );
  if (rows.length !== unique.length) {
    throw errors.subscriptionNotFound();
  }
}

export interface CollectionEntriesChangeResult {
  /** The articles whose membership actually changed. */
  entryIds: string[];
  /** Absolute counts for the collection, its tags and All; absent when nothing changed. */
  counts?: BulkUnreadCounts;
}

/**
 * Adds articles to a collection. Only articles the user can already see are
 * added (anything else is silently skipped, like an unknown id), so a
 * collection can't be used to reach content the user has no access to.
 */
export async function addEntriesToCollection(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  entryIds: string[]
): Promise<CollectionEntriesChangeResult> {
  await assertOwnedCollections(db, userId, [subscriptionId]);
  if (entryIds.length === 0) {
    return { entryIds: [] };
  }

  const added = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(collectionEntries)
      .select(
        tx
          .select({
            subscriptionId: sql<string>`${subscriptionId}::uuid`.as("subscription_id"),
            userId: visibleEntries.userId,
            entryId: visibleEntries.id,
            createdAt: sql<Date>`now()`.as("created_at"),
          })
          .from(visibleEntries)
          .where(and(eq(visibleEntries.userId, userId), inArray(visibleEntries.id, entryIds)))
      )
      .onConflictDoNothing()
      .returning({ entryId: collectionEntries.entryId });
    const ids = inserted.map((row) => row.entryId);
    await touchUserEntries(tx, userId, ids);
    return ids;
  });

  return finishMembershipChange(db, userId, subscriptionId, added, true);
}

export async function removeEntriesFromCollection(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  entryIds: string[]
): Promise<CollectionEntriesChangeResult> {
  await assertOwnedCollections(db, userId, [subscriptionId]);
  if (entryIds.length === 0) {
    return { entryIds: [] };
  }

  const removed = await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(collectionEntries)
      .where(
        and(
          eq(collectionEntries.subscriptionId, subscriptionId),
          eq(collectionEntries.userId, userId),
          inArray(collectionEntries.entryId, entryIds)
        )
      )
      .returning({ entryId: collectionEntries.entryId });
    const ids = deleted.map((row) => row.entryId);
    await touchUserEntries(tx, userId, ids);
    return ids;
  });

  return finishMembershipChange(db, userId, subscriptionId, removed, false);
}

/** Adds one article to several collections (e.g. right after saving it). */
export async function addEntryToCollections(
  db: typeof dbType,
  userId: string,
  entryId: string,
  subscriptionIds: string[]
): Promise<void> {
  for (const subscriptionId of new Set(subscriptionIds)) {
    await addEntriesToCollection(db, userId, subscriptionId, [entryId]);
  }
}

/**
 * Membership is part of an entry's per-user state: moving
 * `user_entries.updated_at` makes delta sync re-deliver the entry, or report
 * it hidden when leaving the collection took it out of view.
 */
async function touchUserEntries(
  tx: Transaction,
  userId: string,
  entryIds: string[]
): Promise<void> {
  if (entryIds.length === 0) return;
  await tx
    .update(userEntries)
    .set({ updatedAt: new Date() })
    .where(and(eq(userEntries.userId, userId), inArray(userEntries.entryId, entryIds)));
}

async function finishMembershipChange(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  changedIds: string[],
  added: boolean
): Promise<CollectionEntriesChangeResult> {
  if (changedIds.length === 0) {
    return { entryIds: [] };
  }
  // Source subscriptions' counts don't change; All (always included) can,
  // when an article's only route into view is a collection.
  const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId }]);

  publishCollectionEntriesChanged(
    userId,
    subscriptionId,
    changedIds,
    added,
    new Date(),
    counts
  ).catch((err) => {
    logger.error("Failed to publish collection_entries_changed event", {
      err,
      userId,
      subscriptionId,
    });
  });

  return { entryIds: changedIds, counts };
}
