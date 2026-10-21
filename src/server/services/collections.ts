/**
 * Collections Service (#1806)
 *
 * A collection is a list of articles the user fills by hand (or through an AI
 * assistant). It is a subscription of type 'collection' with no feed (#1846),
 * so everything that handles subscriptions (tags, renaming, unread counters,
 * the sidebar, deletion) handles collections too. Members are memberships
 * (`subscription_entries`), never copies: an article keeps its source feed and
 * its read/starred state.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { db as dbType, DbOrTx, Transaction } from "@/server/db";
import {
  subscriptionEntries,
  subscriptions,
  userEntries,
  visibleEntries,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import { publishUserEvent } from "@/server/redis/pubsub";
import { subscriptionCreatedEvent } from "@/server/services/subscription-sync-events";
import { getBulkEntryRelatedCounts, type BulkUnreadCounts } from "@/server/services/counts";
import { publishEntryStates } from "@/server/services/entry-state";
import {
  getSubscription,
  isCollectionSubscription,
  lockAndCountActiveSubscriptions,
  type Subscription,
} from "@/server/services/subscriptions";
import { errors, getAppErrorCode } from "@/server/errors";
import { MAX_COLLECTION_ENTRIES } from "@/lib/collections";
import { isUniqueViolation } from "@/server/db/errors";

/** The user's active collections holding an entry. */
export async function listEntryCollectionIds(
  db: typeof dbType,
  userId: string,
  entryId: string
): Promise<string[]> {
  const rows = await db
    .select({ id: subscriptionEntries.subscriptionId })
    .from(subscriptionEntries)
    .innerJoin(subscriptions, eq(subscriptions.id, subscriptionEntries.subscriptionId))
    .where(
      and(
        eq(subscriptionEntries.userId, userId),
        eq(subscriptionEntries.entryId, entryId),
        isCollectionSubscription(),
        isNull(subscriptions.unsubscribedAt)
      )
    )
    .orderBy(subscriptionEntries.subscriptionId);
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
 * index `uq_subscriptions_user_collection_name` does. Served by the user's
 * active-subscriptions index (`idx_subscriptions_user_active`): `type` is a
 * bound parameter, so a generic plan can't match the unique index's partial
 * predicate.
 */
async function findActiveCollectionByName(
  db: DbOrTx,
  userId: string,
  name: string
): Promise<string | undefined> {
  const [row] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        isCollectionSubscription(),
        isNull(subscriptions.unsubscribedAt),
        sql`lower(${subscriptions.customTitle}) = lower(${name})`
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
    let outcome: { existingId: string } | { created: Subscription };
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
        return { created: await insertCollection(tx, userId, name) };
      });
    } catch (err) {
      // A rename doesn't take the creation lock, so it can take the name
      // between the lookup and the insert.
      if (!isUniqueViolation(err)) throw err;
      const existingId = await findActiveCollectionByName(db, userId, name);
      if (existingId === undefined) continue;
      outcome = { existingId };
    }

    if ("created" in outcome) {
      return finishCreate(db, userId, outcome.created);
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
): Promise<Subscription> {
  const subscriptionId = generateUuidv7();
  const now = new Date();
  await tx.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    type: "collection",
    customTitle: name,
    subscribedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return getSubscription(tx, userId, subscriptionId);
}

async function finishCreate(
  db: typeof dbType,
  userId: string,
  subscription: Subscription
): Promise<CreateCollectionResult> {
  const counts = await getBulkEntryRelatedCounts(db, userId, [{ subscriptionId: subscription.id }]);

  publishUserEvent({
    ...subscriptionCreatedEvent(subscription),
    userId,
    // No feed channel to follow.
    feedId: null,
    updatedAt: subscription.subscribedAt,
    counts,
  });

  return { subscription, counts, created: true };
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
 * `positions` places articles as they join, so the event announcing them
 * carries their place; an article already in the collection keeps its own.
 */
export async function addEntriesToCollection(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  entryIds: string[],
  positions?: ReadonlyMap<string, number>
): Promise<CollectionEntriesChangeResult> {
  const added = await db.transaction(async (tx) => {
    await lockUserEntryRows(tx, userId, entryIds);
    await assertOwnedCollections(tx, userId, [subscriptionId], { lock: true });
    if (entryIds.length === 0) return [];
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(subscriptionEntries)
      .where(eq(subscriptionEntries.subscriptionId, subscriptionId));
    if (count + entryIds.length > MAX_COLLECTION_ENTRIES) {
      throw errors.validation(`A collection can hold at most ${MAX_COLLECTION_ENTRIES} articles`);
    }
    const inserted = await tx
      .insert(subscriptionEntries)
      .select(
        tx
          .select({
            subscriptionId: sql<string>`${subscriptionId}::uuid`.as("subscription_id"),
            userId: visibleEntries.userId,
            entryId: visibleEntries.id,
            publishedOrFetchedAt: visibleEntries.publishedOrFetchedAt,
            read: visibleEntries.read,
            starred: visibleEntries.starred,
            isSpam: visibleEntries.isSpam,
            score: visibleEntries.score,
            position: (positions?.size
              ? sql<number | null>`CASE ${visibleEntries.id} ${sql.join(
                  [...positions].map(
                    ([entryId, position]) =>
                      sql`WHEN ${entryId}::uuid THEN ${position}::double precision`
                  ),
                  sql` `
                )} END`
              : sql<number | null>`NULL::double precision`
            ).as("position"),
          })
          .from(visibleEntries)
          .where(and(eq(visibleEntries.userId, userId), inArray(visibleEntries.id, entryIds)))
      )
      .onConflictDoNothing()
      .returning({ entryId: subscriptionEntries.entryId });
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
      .delete(subscriptionEntries)
      .where(
        and(
          eq(subscriptionEntries.subscriptionId, subscriptionId),
          eq(subscriptionEntries.userId, userId),
          inArray(subscriptionEntries.entryId, entryIds)
        )
      )
      .returning({ entryId: subscriptionEntries.entryId });
    const ids = deleted.map((row) => row.entryId);
    await touchUserEntries(tx, userId, ids);
    return ids;
  });

  return finishMembershipChange(db, userId, subscriptionId, removed, false);
}

/** The collection's highest position, or 0 when none of its articles has one. */
export async function maxCollectionPosition(
  db: typeof dbType,
  userId: string,
  subscriptionId: string
): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${subscriptionEntries.position})` })
    .from(subscriptionEntries)
    .where(
      and(
        eq(subscriptionEntries.subscriptionId, subscriptionId),
        eq(subscriptionEntries.userId, userId)
      )
    );
  return row?.max ?? 0;
}

export interface CollectionPosition {
  entryId: string;
  /** Any finite number (lower sorts first), or null to clear it. */
  position: number | null;
}

/**
 * Sets or clears articles' positions in a collection (#2064), its order when
 * sorted by position. An article named twice takes its last position;
 * articles that aren't in the collection are skipped and returned.
 */
export async function setCollectionPositions(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  positions: CollectionPosition[]
): Promise<{ changedIds: string[]; notInCollectionIds: string[] }> {
  if (positions.length > MAX_COLLECTION_ENTRIES) {
    throw errors.validation(`Maximum ${MAX_COLLECTION_ENTRIES} positions per request`);
  }
  if (positions.some(({ position }) => position !== null && !Number.isFinite(position))) {
    throw errors.validation("A position must be a finite number or null");
  }
  const byEntry = new Map(positions.map(({ entryId, position }) => [entryId, position]));
  const entryIds = [...byEntry.keys()];

  const { members, changed } = await db.transaction(async (tx) => {
    // The memberships come after their user_entries rows in the lock order,
    // as a mark-read's copy trigger takes them.
    await lockUserEntryRows(tx, userId, entryIds);
    await assertOwnedCollections(tx, userId, [subscriptionId]);
    if (entryIds.length === 0) return { members: [], changed: [] };
    const values = [...byEntry].map(
      ([entryId, position]) => sql`(${entryId}::uuid, ${position}::double precision)`
    );
    const members = await tx
      .select({ entryId: subscriptionEntries.entryId })
      .from(subscriptionEntries)
      .where(
        and(
          eq(subscriptionEntries.subscriptionId, subscriptionId),
          eq(subscriptionEntries.userId, userId),
          inArray(subscriptionEntries.entryId, entryIds)
        )
      );
    const updated = await tx.execute<{ entry_id: string }>(sql`
      UPDATE ${subscriptionEntries}
      SET position = v.position
      FROM (VALUES ${sql.join(values, sql`, `)}) AS v(entry_id, position)
      WHERE ${subscriptionEntries.subscriptionId} = ${subscriptionId}::uuid
        AND ${subscriptionEntries.userId} = ${userId}::uuid
        AND ${subscriptionEntries.entryId} = v.entry_id
        AND ${subscriptionEntries.position} IS DISTINCT FROM v.position
      RETURNING ${subscriptionEntries.entryId}
    `);
    // Positions travel with the entry's state, so delta sync re-delivers it.
    await touchUserEntries(
      tx,
      userId,
      updated.rows.map((row) => row.entry_id)
    );
    return { members, changed: updated.rows };
  });

  const found = new Set(members.map((row) => row.entryId));
  publishEntryStates(
    db,
    userId,
    changed.map((row) => row.entry_id)
  );
  return {
    changedIds: changed.map((row) => row.entry_id),
    notInCollectionIds: entryIds.filter((id) => !found.has(id)),
  };
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
 * memberships), so their collection badges update. `counts` must cover the
 * collections (`getBulkEntryRelatedCounts` of them as subscriptions).
 */
export function publishEntryLeftCollections(
  userId: string,
  entryId: string,
  collectionIds: string[],
  counts: BulkUnreadCounts
): void {
  for (const subscriptionId of collectionIds) {
    publishUserEvent({
      type: "collection_entries_changed",
      userId,
      subscriptionId,
      entryIds: [entryId],
      added: false,
      counts,
      updatedAt: new Date(),
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

  publishUserEvent({
    type: "collection_entries_changed",
    userId,
    subscriptionId,
    entryIds: changedIds,
    added,
    counts,
    updatedAt: new Date(),
  });

  return { entryIds: changedIds, counts };
}
