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
import type { db as dbType, DbOrTx, Transaction } from "@/server/db";
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
  getSubscription,
  isCollectionSubscription,
  lockAndCountActiveSubscriptions,
  type Subscription,
} from "@/server/services/subscriptions";
import { errors, getAppErrorCode } from "@/server/trpc/errors";
import { MAX_COLLECTION_ENTRIES } from "@/lib/collections";
import { isUniqueViolation } from "@/server/db/errors";

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
  /** False when an active collection with this name (ignoring case) already existed; it's returned unchanged. */
  created: boolean;
}

/**
 * The user's active collection with this name, ignoring case as the unique
 * index `uq_subscriptions_user_collection_name` does. Matches the displayed
 * name, so it also finds a collection the previous release created without a
 * `custom_title` during the rollout (#1846).
 */
async function findActiveCollectionByName(
  db: DbOrTx,
  userId: string,
  name: string
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
    .where(
      and(
        eq(subscriptions.userId, userId),
        isCollectionSubscription(),
        isNull(subscriptions.unsubscribedAt),
        sql`lower(COALESCE(${subscriptions.customTitle}, ${feeds.title})) = lower(${name})`
      )
    )
    .limit(1);
  return row?.id;
}

/**
 * Creates a collection, or returns the user's active collection with this
 * name (ignoring case) unchanged, so retried and concurrent creates are
 * harmless. Only a real creation is checked against the subscription cap and
 * publishes `subscription_created`.
 */
export async function createCollection(
  db: typeof dbType,
  userId: string,
  name: string
): Promise<CreateCollectionResult> {
  // The collection found can be deleted or renamed before it's read back;
  // then the next attempt creates one.
  for (let attempt = 0; attempt < 2; attempt++) {
    let outcome: { existingId: string } | { feedId: string; subscriptionId: string; now: Date };
    try {
      outcome = await db.transaction(async (tx) => {
        // The creation lock serializes the lookup and insert with the user's
        // other creates.
        const activeCount = await lockAndCountActiveSubscriptions(tx, userId);
        const existingId = await findActiveCollectionByName(tx, userId, name);
        if (existingId) return { existingId };
        const maxSubs = usageLimitsConfig.maxSubscriptionsPerUser;
        if (activeCount >= maxSubs) {
          throw errors.maxSubscriptionsReached(maxSubs);
        }
        return insertCollection(tx, userId, name);
      });
    } catch (err) {
      // A rename doesn't take the creation lock, so it can take the name
      // between the lookup and the insert.
      if (!isUniqueViolation(err)) throw err;
      const existingId = await findActiveCollectionByName(db, userId, name);
      if (existingId === undefined) continue;
      outcome = { existingId };
    }

    if (!("existingId" in outcome)) {
      return finishCreate(db, userId, name, outcome);
    }
    const existing = await getActiveCollection(db, userId, outcome.existingId);
    if (existing) {
      const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: existing.id }]);
      return { subscription: existing, counts, created: false };
    }
  }
  throw errors.collectionNameTaken();
}

async function getActiveCollection(
  db: typeof dbType,
  userId: string,
  subscriptionId: string
): Promise<Subscription | undefined> {
  try {
    return await getSubscription(db, userId, subscriptionId);
  } catch (err) {
    if (getAppErrorCode(err) === "SUBSCRIPTION_NOT_FOUND") return undefined;
    throw err;
  }
}

async function insertCollection(
  tx: Transaction,
  userId: string,
  name: string
): Promise<{ feedId: string; subscriptionId: string; now: Date }> {
  const feedId = generateUuidv7();
  const subscriptionId = generateUuidv7();
  const now = new Date();
  await tx.insert(feeds).values({
    id: feedId,
    type: "collection",
    userId,
    // The previous release reads the name from here (#1846).
    title: name,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    feedId,
    type: "collection",
    customTitle: name,
    subscribedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { feedId, subscriptionId, now };
}

async function finishCreate(
  db: typeof dbType,
  userId: string,
  name: string,
  { feedId, subscriptionId, now }: { feedId: string; subscriptionId: string; now: Date }
): Promise<CreateCollectionResult> {
  const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId }]);
  const feedData = {
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
      customTitle: name,
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
    created: true,
  };
}

/**
 * Throws unless every id is one of the user's active collections, the only
 * kind of subscription articles can be added to. With `lock`, holds a row
 * lock on them until the transaction ends, so a concurrent delete (which
 * empties the collection) can't run before an add commits and strand a
 * member in a deleted collection.
 */
export async function assertOwnedCollections(
  db: DbOrTx,
  userId: string,
  subscriptionIds: string[],
  { lock = false }: { lock?: boolean } = {}
): Promise<void> {
  const unique = [...new Set(subscriptionIds)];
  if (unique.length === 0) return;
  const query = db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        inArray(subscriptions.id, unique),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        isCollectionSubscription()
      )
    );
  // Not FOR SHARE: the membership triggers update this row's counters, and two
  // adds upgrading their share locks would deadlock.
  const rows = lock ? await query.for("no key update", { of: subscriptions }) : await query;
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
  const added = await db.transaction(async (tx) => {
    await lockUserEntryRows(tx, userId, entryIds);
    await assertOwnedCollections(tx, userId, [subscriptionId], { lock: true });
    if (entryIds.length === 0) return [];
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(collectionEntries)
      .where(eq(collectionEntries.subscriptionId, subscriptionId));
    if (count + entryIds.length > MAX_COLLECTION_ENTRIES) {
      throw errors.validation(`A collection can hold at most ${MAX_COLLECTION_ENTRIES} articles`);
    }
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
  const removed = await db.transaction(async (tx) => {
    await lockUserEntryRows(tx, userId, entryIds);
    await assertOwnedCollections(tx, userId, [subscriptionId], { lock: true });
    if (entryIds.length === 0) return [];
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

/**
 * Adds a just-saved article to collections the caller already checked with
 * assertOwnedCollections. Best effort: the save has already happened, so a
 * collection deleted in between is skipped (and logged) rather than failing
 * the save.
 */
export async function addEntryToCollections(
  db: typeof dbType,
  userId: string,
  entryId: string,
  subscriptionIds: string[]
): Promise<void> {
  for (const subscriptionId of new Set(subscriptionIds)) {
    try {
      await addEntriesToCollection(db, userId, subscriptionId, [entryId]);
    } catch (err) {
      logger.warn("Skipped adding a saved article to a collection", {
        userId,
        subscriptionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Locks the user's rows for these entries before anything else, matching the
 * unread-counter triggers' lock order (user_entries rows, subscriptions,
 * users, tags); marking one of them read concurrently would otherwise
 * deadlock against this transaction.
 */
async function lockUserEntryRows(tx: Transaction, userId: string, entryIds: string[]) {
  if (entryIds.length === 0) return;
  await tx
    .select({ entryId: userEntries.entryId })
    .from(userEntries)
    .where(and(eq(userEntries.userId, userId), inArray(userEntries.entryId, entryIds)))
    .orderBy(userEntries.entryId)
    .for("no key update");
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

/**
 * Tells the user's clients an entry left collections without a membership
 * call, e.g. because the entry itself was deleted (the trigger removed the
 * memberships), so their collection badges update.
 */
export async function publishEntryLeftCollections(
  db: typeof dbType,
  userId: string,
  entryId: string,
  collectionIds: string[]
): Promise<void> {
  if (collectionIds.length === 0) return;
  const counts = await getBulkEntryRelatedCounts(
    db,
    userId,
    collectionIds.map((subscriptionId) => ({ subscriptionId }))
  );
  for (const subscriptionId of collectionIds) {
    publishCollectionEntriesChanged(
      userId,
      subscriptionId,
      [entryId],
      false,
      new Date(),
      counts
    ).catch((err) => {
      logger.error("Failed to publish collection_entries_changed event", { err, userId });
    });
  }
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
