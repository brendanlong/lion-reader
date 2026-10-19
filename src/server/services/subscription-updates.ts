/**
 * Changes to one of the user's existing subscriptions: renaming and its
 * full-content setting, its tags, and unsubscribing. Each locks the
 * subscription row first (`lockSubscriptionRow`), as the lock order in
 * `src/server/CLAUDE.md` requires, and publishes only a real change.
 */

import { eq, and, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { db as dbType, DbOrTx } from "@/server/db";
import {
  blockedSenders,
  subscriptionEntries,
  subscriptions,
  tags,
  subscriptionTags,
  userEntries,
} from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { logger } from "@/lib/logger";
import { publishUserEvent } from "@/server/redis/pubsub";
import { subscriptionUpdatedEvent } from "@/server/services/subscription-sync-events";
import { attemptUnsubscribe, getLatestUnsubscribeMailto } from "@/server/email/unsubscribe";
import { getBulkEntryRelatedCounts, type BulkUnreadCounts } from "@/server/services/counts";
import {
  clearedCustomTitle,
  getSubscription,
  isUserManagedSubscription,
  lockSubscriptionMembers,
  type Subscription,
} from "@/server/services/subscriptions";
import { errors } from "@/server/errors";
import { isUniqueViolation } from "@/server/db/errors";

/**
 * Locks one of the user's subscription rows for the rest of the transaction,
 * so a change to its tags or state takes locks in the order `src/server/CLAUDE.md`
 * requires. Unsubscribing moves its members' user_entries rows, so `members`
 * locks those first.
 */
async function lockSubscriptionRow(
  tx: DbOrTx,
  userId: string,
  subscriptionId: string,
  { members = false }: { members?: boolean } = {}
): Promise<void> {
  if (members) {
    await lockSubscriptionMembers(tx, userId, eq(subscriptions.id, subscriptionId));
  }
  await tx
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)))
    .for("update");
}

export const CUSTOM_TITLE_MAX_LENGTH = 255;

export interface UpdateSubscriptionParams {
  /**
   * The new name, trimmed. Blank or null clears it: a feed falls back to its
   * own title, an email subscription to its sender, and a collection, which
   * must have a name, fails.
   */
  customTitle?: string | null;
  fetchFullContent?: boolean;
}

/**
 * Updates one of the user's subscriptions, never Saved. A collection's name is
 * unique among the user's active collections ignoring case
 * (COLLECTION_NAME_TAKEN otherwise). Bumps `updated_at` and publishes
 * subscription_updated only when a value actually changes (#1160).
 */
export async function updateSubscription(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  params: UpdateSubscriptionParams
): Promise<Subscription> {
  const updateData: { customTitle?: string | null; fetchFullContent?: boolean } = {};

  if (params.customTitle !== undefined) {
    const title = params.customTitle?.trim() ?? "";
    if (title.length > CUSTOM_TITLE_MAX_LENGTH) {
      throw errors.validation(`Custom title must be at most ${CUSTOM_TITLE_MAX_LENGTH} characters`);
    }
    if (title) {
      updateData.customTitle = title;
    } else {
      // A subscription's type never changes, so checking first can't race.
      const cleared = await clearedCustomTitle(db, userId, subscriptionId);
      if (!cleared) {
        throw errors.validation("Collection name is required");
      }
      updateData.customTitle = cleared.customTitle;
    }
  }
  if (params.fetchFullContent !== undefined) {
    updateData.fetchFullContent = params.fetchFullContent;
  }

  // `updated_at` drives the subscription delta-sync cursor and gates the
  // publish, so it moves only when a value changes. The self-join on `prev`
  // captures the pre-update values in the UPDATE itself, so a concurrent
  // update can't slip into a pre-SELECT's window.
  const prev = alias(subscriptions, "prev");
  const changedFragments: SQL[] = [];
  if (updateData.customTitle !== undefined) {
    changedFragments.push(sql`${prev.customTitle} IS DISTINCT FROM ${updateData.customTitle}`);
  }
  if (updateData.fetchFullContent !== undefined) {
    changedFragments.push(sql`${prev.fetchFullContent} <> ${updateData.fetchFullContent}`);
  }
  const meaningfulChange =
    changedFragments.length > 0 ? sql`(${sql.join(changedFragments, sql` OR `)})` : sql`false`;

  const now = new Date();
  const [updated] = await db
    .update(subscriptions)
    .set({
      ...updateData,
      updatedAt: sql`CASE WHEN ${meaningfulChange} THEN ${now} ELSE ${prev.updatedAt} END`,
    })
    .from(prev)
    .where(
      and(
        eq(prev.id, subscriptions.id),
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        // The saved subscription can't be renamed (#1846): not found.
        isUserManagedSubscription()
      )
    )
    .returning({ changed: sql<boolean>`${meaningfulChange}` })
    .catch((err: unknown) => {
      // Only custom_title can collide: with another active collection's name.
      throw isUniqueViolation(err) ? errors.collectionNameTaken() : err;
    });

  if (!updated) {
    throw errors.subscriptionNotFound();
  }

  const subscription = await getSubscription(db, userId, subscriptionId);
  if (updated.changed) {
    publishUserEvent({ ...subscriptionUpdatedEvent(subscription), userId, updatedAt: now });
  }
  return subscription;
}

/**
 * Replaces a subscription's tags (an empty list makes it uncategorized).
 * Publishes subscription_updated and bumps updated_at only on a real change.
 */
export async function setSubscriptionTags(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  tagIds: string[]
): Promise<Subscription> {
  return changeSubscriptionTags(db, userId, subscriptionId, { set: tagIds });
}

/**
 * Adds and removes some of a subscription's tags, leaving the others, for
 * clients that edit tags one at a time (Google Reader). Same rules as
 * {@link setSubscriptionTags}.
 */
export async function editSubscriptionTags(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  change: { add: string[]; remove: string[] }
): Promise<void> {
  await changeSubscriptionTags(db, userId, subscriptionId, change);
}

async function changeSubscriptionTags(
  db: typeof dbType,
  userId: string,
  subscriptionId: string,
  change: { set: string[] } | { add: string[]; remove: string[] }
): Promise<Subscription> {
  const addedTagIds = [...new Set("set" in change ? change.set : change.add)];
  // The saved subscription can't be tagged (#1846), so it's not found.
  const [existingSubscription] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        isUserManagedSubscription()
      )
    )
    .limit(1);

  if (!existingSubscription) {
    throw errors.subscriptionNotFound();
  }

  // Excluding tombstoned tags prevents assigning a tag that is invisible in
  // listTags (which would silently drop the subscription from "Uncategorized").
  const validTags =
    addedTagIds.length === 0
      ? []
      : await db
          .select({ id: tags.id })
          .from(tags)
          .where(
            and(eq(tags.userId, userId), inArray(tags.id, addedTagIds), isNull(tags.deletedAt))
          );
  if (validTags.length !== addedTagIds.length) {
    throw errors.validation("One or more tag IDs are invalid or do not belong to you");
  }

  const now = new Date();

  // One transaction, or a crash or concurrent call between the delete and the
  // insert could leave a partial tag set (#952).
  const after = await db.transaction(async (tx) => {
    // Subscription row first: the counter triggers lock subscriptions, then
    // users, then tags, and the tag changes below reach users and tags. The
    // row is read under the lock, so the event can't revert a concurrent
    // rename.
    await lockSubscriptionRow(tx, userId, subscriptionId);

    let changed: boolean;
    if ("set" in change) {
      // RETURNING captures the prior tag set race-free, to tell a real change
      // from a re-apply of the identical set (#1160).
      const deleted = await tx
        .delete(subscriptionTags)
        .where(eq(subscriptionTags.subscriptionId, subscriptionId))
        .returning({ tagId: subscriptionTags.tagId });
      if (addedTagIds.length > 0) {
        await tx
          .insert(subscriptionTags)
          .values(addedTagIds.map((tagId) => ({ subscriptionId, tagId, createdAt: now })));
      }
      const previousTagIds = new Set(deleted.map((d) => d.tagId));
      changed =
        previousTagIds.size !== addedTagIds.length ||
        !addedTagIds.every((id) => previousTagIds.has(id));
    } else {
      const removedTagIds = change.remove.filter((id) => !addedTagIds.includes(id));
      const deleted =
        removedTagIds.length === 0
          ? []
          : await tx
              .delete(subscriptionTags)
              .where(
                and(
                  eq(subscriptionTags.subscriptionId, subscriptionId),
                  inArray(subscriptionTags.tagId, removedTagIds)
                )
              )
              .returning({ tagId: subscriptionTags.tagId });
      const inserted =
        addedTagIds.length === 0
          ? []
          : await tx
              .insert(subscriptionTags)
              .values(addedTagIds.map((tagId) => ({ subscriptionId, tagId, createdAt: now })))
              .onConflictDoNothing()
              .returning({ tagId: subscriptionTags.tagId });
      changed = deleted.length > 0 || inserted.length > 0;
    }

    if (changed) {
      // updated_at drives the subscription delta-sync cursor.
      await tx
        .update(subscriptions)
        .set({ updatedAt: now })
        .where(eq(subscriptions.id, subscriptionId));
    }
    return { changed, subscription: await getSubscription(tx, userId, subscriptionId) };
  });

  if (after.changed) {
    publishUserEvent({ ...subscriptionUpdatedEvent(after.subscription), userId, updatedAt: now });
  }
  return after.subscription;
}

/**
 * Unsubscribes (soft-deletes) one of the user's active subscriptions, returning
 * the affected lists' post-delete absolute counts, or null if there is no such
 * active subscription. Every unsubscribe path goes through here so they all do
 * the same thing: for an email subscription, send the sender's list-unsubscribe request
 * and block the sender; then remove its tags, soft-delete it, and publish
 * subscription_deleted.
 */
export async function unsubscribe(
  db: typeof dbType,
  userId: string,
  subscriptionId: string
): Promise<{ counts: BulkUnreadCounts } | null> {
  const [existing] = await db
    .select({
      feedId: subscriptions.feedId,
      type: subscriptions.type,
      emailSender: subscriptions.emailSender,
    })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        // The saved subscription can't be unsubscribed (#1846).
        isUserManagedSubscription()
      )
    )
    .limit(1);

  if (!existing) {
    return null;
  }

  const now = new Date();

  // The unsubscribe request and mailto lookup are network/side-effecting work,
  // so they run BEFORE the transaction; only the blocked_senders row is written
  // inside it. Both read the emails the subscription owns (#1846).
  let blockedSenderValues: typeof blockedSenders.$inferInsert | null = null;
  if (existing.type === "email" && existing.emailSender) {
    const unsubscribeResult = await attemptUnsubscribe(subscriptionId);

    logger.info("Email unsubscribe attempt completed", {
      subscriptionId,
      userId,
      senderEmail: existing.emailSender,
      sent: unsubscribeResult.sent,
      method: unsubscribeResult.method,
    });

    blockedSenderValues = {
      id: generateUuidv7(),
      userId,
      senderEmail: existing.emailSender,
      blockedAt: now,
      listUnsubscribeMailto: await getLatestUnsubscribeMailto(subscriptionId),
      unsubscribeSentAt: unsubscribeResult.sent ? now : null,
    };
  }

  // One transaction so a crash can't half-apply the unsubscribe (e.g. tags
  // removed but the subscription still active) (issue #952).
  const formerTagIds = await db.transaction(async (tx) => {
    await lockSubscriptionRow(tx, userId, subscriptionId, { members: true });

    // Re-checked under the lock: a concurrent unsubscribe may have finished
    // since the check above.
    const softDeleted = await tx
      .update(subscriptions)
      .set({ unsubscribedAt: now, updatedAt: now })
      .where(
        and(
          eq(subscriptions.id, subscriptionId),
          eq(subscriptions.userId, userId),
          isNull(subscriptions.unsubscribedAt)
        )
      )
      .returning({ id: subscriptions.id, type: subscriptions.type });
    if (softDeleted.length === 0) {
      return null;
    }
    if (softDeleted[0].type === "collection") {
      // Its members leave a collection, which is per-user entry state: move
      // their updated_at so delta sync re-delivers them (or reports them
      // hidden), as removing them one by one would. Their rows are locked.
      await tx
        .update(userEntries)
        .set({ updatedAt: now })
        .where(
          and(
            eq(userEntries.userId, userId),
            inArray(
              userEntries.entryId,
              tx
                .select({ id: subscriptionEntries.entryId })
                .from(subscriptionEntries)
                .where(eq(subscriptionEntries.subscriptionId, subscriptionId))
            )
          )
        );
    }

    if (blockedSenderValues) {
      await tx.insert(blockedSenders).values(blockedSenderValues).onConflictDoNothing();
      logger.info("Added sender to blocked list", {
        userId,
        senderEmail: blockedSenderValues.senderEmail,
      });
    }

    // Remove the tag associations so resubscribing starts fresh. RETURNING
    // captures the former tags for the post-delete counts (an empty list means
    // the subscription was uncategorized).
    const formerTagRows = await tx
      .delete(subscriptionTags)
      .where(
        inArray(
          subscriptionTags.subscriptionId,
          tx
            .select({ id: subscriptions.id })
            .from(subscriptions)
            .where(and(eq(subscriptions.id, subscriptionId), eq(subscriptions.userId, userId)))
        )
      )
      .returning({ tagId: subscriptionTags.tagId });

    return formerTagRows.map((r) => r.tagId);
  });

  if (!formerTagIds) {
    return null;
  }

  // Computed after the soft-delete so they reflect the removal. The client sets
  // these directly (the sync.events catch-up path can't recompute the former
  // tags, so it omits counts and the client invalidates instead).
  const counts = await getBulkEntryRelatedCounts(db, userId, [], {
    formerTagIds: [formerTagIds],
  });

  publishUserEvent({
    type: "subscription_deleted",
    userId,
    feedId: existing.feedId,
    subscriptionId,
    updatedAt: now,
    counts,
  });

  return { counts };
}
