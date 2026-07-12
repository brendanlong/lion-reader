/**
 * Tags Service
 *
 * Business logic for tag operations. Used by both tRPC routers and MCP server.
 */

import { eq, and, sql, isNull } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { tags, subscriptionTags, subscriptions } from "@/server/db/schema";
import { errors } from "@/server/trpc/errors";
import { isUniqueViolation } from "@/server/db/errors";
import { generateUuidv7 } from "@/lib/uuidv7";
import { publishTagCreated, publishTagUpdated, publishTagDeleted } from "@/server/redis/pubsub";

// ============================================================================
// Types
// ============================================================================

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  feedCount: number;
  unreadCount: number;
  createdAt: Date;
}

export interface UncategorizedCounts {
  feedCount: number;
  unreadCount: number;
}

export interface ListTagsResult {
  items: Tag[];
  uncategorized: UncategorizedCounts;
}

export interface CreateTagParams {
  name: string;
  color?: string | null;
}

export interface UpdateTagParams {
  name?: string;
  color?: string | null;
}

// ============================================================================
// Helper: Per-Tag Unread Counts
// ============================================================================

/**
 * Builds a grouped subquery of per-tag unread counts for a user.
 *
 * The tag badge is SUM of the trigger-maintained `subscriptions.unread_count`
 * counters (migration 0092, spam excluded) over each tag's ACTIVE
 * subscriptions — starred entries from unsubscribed feeds belong to Starred,
 * not to a tag's unread badge, so inactive subscriptions are excluded.
 * subscription_tags is unique per (tag, subscription), so each subscription's
 * counter contributes exactly once per tag.
 *
 * Computing all tags in one grouped aggregation (instead of a correlated
 * subquery per tag row) keeps listTags to a single query (#831); updateTag
 * reuses this for a single tag by filtering on tag_id.
 */
function tagUnreadCountsQuery(db: typeof dbType, userId: string) {
  return db
    .select({
      tagId: subscriptionTags.tagId,
      unreadCount: sql<number>`sum(${subscriptions.unreadCount})::int`.as("unread_count"),
    })
    .from(subscriptionTags)
    .innerJoin(
      subscriptions,
      and(
        eq(subscriptions.id, subscriptionTags.subscriptionId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt)
      )
    )
    .groupBy(subscriptionTags.tagId)
    .as("tag_unread_counts");
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Lists all tags for a user with feed counts and unread counts.
 * Also returns uncategorized subscription counts.
 */
export async function listTags(db: typeof dbType, userId: string): Promise<ListTagsResult> {
  const tagUnreadCounts = tagUnreadCountsQuery(db, userId);

  const [userTags, uncategorizedFeedCount, uncategorizedUnread] = await Promise.all([
    db
      .select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
        createdAt: tags.createdAt,
        feedCount: sql<number>`(
          SELECT COUNT(*)::int
          FROM ${subscriptionTags}
          WHERE ${subscriptionTags.tagId} = "tags"."id"
        )`,
        unreadCount: sql<number>`COALESCE(${tagUnreadCounts.unreadCount}, 0)`,
      })
      .from(tags)
      .leftJoin(tagUnreadCounts, eq(tagUnreadCounts.tagId, tags.id))
      .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)))
      .orderBy(tags.name),
    // Uncategorized feed count: active subscriptions with no tags. This needs no
    // entry data, so it's a cheap standalone count rather than a join fan-out.
    db
      .select({ feedCount: sql<number>`COUNT(*)::int` })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          isNull(subscriptions.unsubscribedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM ${subscriptionTags}
            WHERE ${subscriptionTags.subscriptionId} = ${subscriptions.id}
          )`
        )
      ),
    // Uncategorized unread count: SUM of the unread counters over active
    // subscriptions with no tags. Active-only excludes starred orphans
    // (entries kept visible after unsubscribe), which aren't "uncategorized".
    db
      .select({ unreadCount: sql<number>`COALESCE(sum(${subscriptions.unreadCount}), 0)::int` })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          isNull(subscriptions.unsubscribedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM ${subscriptionTags}
            WHERE ${subscriptionTags.subscriptionId} = ${subscriptions.id}
          )`
        )
      ),
  ]);

  return {
    items: userTags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
      feedCount: tag.feedCount,
      unreadCount: tag.unreadCount,
      createdAt: tag.createdAt,
    })),
    uncategorized: {
      feedCount: uncategorizedFeedCount[0]?.feedCount ?? 0,
      unreadCount: uncategorizedUnread[0]?.unreadCount ?? 0,
    },
  };
}

/**
 * Creates a new tag for a user.
 *
 * @throws validation error if a tag with the same name already exists
 */
export async function createTag(
  db: typeof dbType,
  userId: string,
  params: CreateTagParams
): Promise<Tag> {
  const tagId = generateUuidv7();
  const now = new Date();

  const result = await db
    .insert(tags)
    .values({
      id: tagId,
      userId,
      name: params.name,
      color: params.color ?? null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      createdAt: tags.createdAt,
      updatedAt: tags.updatedAt,
    });

  if (result.length === 0) {
    throw errors.validation("A tag with this name already exists");
  }

  const createdTag = result[0];

  // Publish tag created event for multi-tab/device sync (fire and forget)
  publishTagCreated(
    userId,
    {
      id: createdTag.id,
      name: createdTag.name,
      color: createdTag.color,
    },
    createdTag.updatedAt
  ).catch(() => {
    // Ignore publish errors - SSE is best-effort
  });

  return {
    id: createdTag.id,
    name: createdTag.name,
    color: createdTag.color,
    feedCount: 0,
    unreadCount: 0,
    createdAt: createdTag.createdAt,
  };
}

/**
 * Updates an existing tag.
 *
 * @throws tagNotFound if tag doesn't exist or doesn't belong to user
 * @throws validation error if new name conflicts with an existing tag
 */
export async function updateTag(
  db: typeof dbType,
  userId: string,
  tagId: string,
  params: UpdateTagParams
): Promise<Tag> {
  // Verify the tag exists and belongs to the user (and is not deleted)
  const existingTag = await db
    .select()
    .from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.userId, userId), isNull(tags.deletedAt)))
    .limit(1);

  if (existingTag.length === 0) {
    throw errors.tagNotFound();
  }

  // If name is being updated, check for duplicates among *live* tags only.
  // Soft-deleted (tombstoned) tags keep their name for sync tracking but must
  // not block reusing it, matching the partial unique index (issue #952).
  if (params.name !== undefined && params.name !== existingTag[0].name) {
    const duplicateName = await db
      .select()
      .from(tags)
      .where(and(eq(tags.userId, userId), eq(tags.name, params.name), isNull(tags.deletedAt)))
      .limit(1);

    if (duplicateName.length > 0) {
      throw errors.validation("A tag with this name already exists");
    }
  }

  // Build the update object - always set updatedAt on changes
  const updateData: { name?: string; color?: string | null; updatedAt: Date } = {
    updatedAt: new Date(),
  };

  if (params.name !== undefined) {
    updateData.name = params.name;
  }

  if (params.color !== undefined) {
    updateData.color = params.color;
  }

  // The duplicate check above is check-then-act; a concurrent rename to the same
  // name can still slip in between and trip the partial unique index. Catch that
  // as a validation error instead of surfacing a raw 500.
  try {
    await db.update(tags).set(updateData).where(eq(tags.id, tagId));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw errors.validation("A tag with this name already exists");
    }
    throw err;
  }

  // Get updated tag with feed count and unread count
  const tagUnreadCounts = tagUnreadCountsQuery(db, userId);
  const [updatedTag, unreadResult] = await Promise.all([
    db
      .select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
        createdAt: tags.createdAt,
        updatedAt: tags.updatedAt,
        feedCount: sql<number>`count(${subscriptionTags.subscriptionId})::int`,
      })
      .from(tags)
      .leftJoin(subscriptionTags, eq(subscriptionTags.tagId, tags.id))
      .where(and(eq(tags.id, tagId), eq(tags.userId, userId)))
      .groupBy(tags.id)
      .limit(1),
    db
      .select({ unreadCount: tagUnreadCounts.unreadCount })
      .from(tagUnreadCounts)
      .where(eq(tagUnreadCounts.tagId, tagId)),
  ]);

  if (updatedTag.length === 0) {
    throw errors.tagNotFound();
  }

  const tag = updatedTag[0];

  // Publish tag updated event for multi-tab/device sync (fire and forget)
  publishTagUpdated(
    userId,
    {
      id: tag.id,
      name: tag.name,
      color: tag.color,
    },
    tag.updatedAt
  ).catch(() => {
    // Ignore publish errors - SSE is best-effort
  });

  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    feedCount: tag.feedCount,
    unreadCount: unreadResult[0]?.unreadCount ?? 0,
    createdAt: tag.createdAt,
  };
}

/**
 * Deletes a tag (soft delete).
 *
 * Sets deleted_at for sync tracking. Subscription-tag associations are removed
 * immediately since they aren't tracked for sync.
 *
 * @throws tagNotFound if tag doesn't exist or doesn't belong to user
 */
export async function deleteTag(db: typeof dbType, userId: string, tagId: string): Promise<void> {
  const now = new Date();

  // Tombstone the tag and drop its subscription associations as one unit, so a
  // crash between them can't leave a soft-deleted tag with live associations
  // (which would silently drop subscriptions from "Uncategorized" while the tag
  // is invisible in listTags).
  const updatedAt = await db.transaction(async (tx) => {
    const deleted = await tx
      .update(tags)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(tags.id, tagId), eq(tags.userId, userId), isNull(tags.deletedAt)))
      .returning({ id: tags.id, updatedAt: tags.updatedAt });

    if (deleted.length === 0) {
      throw errors.tagNotFound();
    }

    // Remove subscription_tags associations (these aren't synced, so hard delete is fine)
    await tx.delete(subscriptionTags).where(eq(subscriptionTags.tagId, tagId));

    return deleted[0].updatedAt;
  });

  // Publish tag deleted event for multi-tab/device sync (fire and forget)
  publishTagDeleted(userId, tagId, updatedAt).catch(() => {
    // Ignore publish errors - SSE is best-effort
  });
}
