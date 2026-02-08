/**
 * Tags Service
 *
 * Business logic for tag operations. Used by both tRPC routers and MCP server.
 */

import { eq, and, sql, isNull } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { tags, subscriptionTags, subscriptions, entries, userEntries } from "@/server/db/schema";
import { errors } from "@/server/trpc/errors";
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
// Helper: Tag Unread Count Query
// ============================================================================

/**
 * Builds a subquery for counting unread entries associated with a tag.
 * Shared between list and update to avoid duplication.
 */
function tagUnreadCountSql(userId: string) {
  return sql<number>`(
    SELECT COUNT(*)::int
    FROM ${subscriptionTags} st
    INNER JOIN ${subscriptions} s
      ON st.subscription_id = s.id
      AND s.unsubscribed_at IS NULL
    INNER JOIN ${entries} e
      ON e.feed_id = ANY(s.feed_ids)
    INNER JOIN ${userEntries} ue
      ON ue.entry_id = e.id
      AND ue.user_id = ${userId}
      AND ue.read = false
    WHERE st.tag_id = "tags"."id"
  )`;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Lists all tags for a user with feed counts and unread counts.
 * Also returns uncategorized subscription counts.
 */
export async function listTags(db: typeof dbType, userId: string): Promise<ListTagsResult> {
  const [userTags, uncategorizedResult] = await Promise.all([
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
        unreadCount: tagUnreadCountSql(userId),
      })
      .from(tags)
      .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)))
      .orderBy(tags.name),
    // Count uncategorized subscriptions (those with no tags)
    db
      .select({
        feedCount: sql<number>`COUNT(DISTINCT ${subscriptions.id})::int`,
        unreadCount: sql<number>`COUNT(DISTINCT ${userEntries.entryId})::int`,
      })
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
      )
      .leftJoin(entries, sql`${entries.feedId} = ANY(${subscriptions.feedIds})`)
      .leftJoin(
        userEntries,
        and(
          eq(userEntries.entryId, entries.id),
          eq(userEntries.userId, userId),
          eq(userEntries.read, false)
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
      feedCount: uncategorizedResult[0]?.feedCount ?? 0,
      unreadCount: uncategorizedResult[0]?.unreadCount ?? 0,
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

  // If name is being updated, check for duplicates
  if (params.name !== undefined && params.name !== existingTag[0].name) {
    const duplicateName = await db
      .select()
      .from(tags)
      .where(and(eq(tags.userId, userId), eq(tags.name, params.name)))
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

  await db.update(tags).set(updateData).where(eq(tags.id, tagId));

  // Get updated tag with feed count and unread count
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
      .select({
        unreadCount: sql<number>`count(*)::int`,
      })
      .from(subscriptionTags)
      .innerJoin(
        subscriptions,
        and(
          eq(subscriptionTags.subscriptionId, subscriptions.id),
          isNull(subscriptions.unsubscribedAt)
        )
      )
      .innerJoin(entries, sql`${entries.feedId} = ANY(${subscriptions.feedIds})`)
      .innerJoin(
        userEntries,
        and(
          eq(userEntries.entryId, entries.id),
          eq(userEntries.userId, userId),
          eq(userEntries.read, false)
        )
      )
      .where(eq(subscriptionTags.tagId, tagId)),
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

  const deleted = await db
    .update(tags)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(tags.id, tagId), eq(tags.userId, userId), isNull(tags.deletedAt)))
    .returning({ id: tags.id, updatedAt: tags.updatedAt });

  if (deleted.length === 0) {
    throw errors.tagNotFound();
  }

  // Remove subscription_tags associations (these aren't synced, so hard delete is fine)
  await db.delete(subscriptionTags).where(eq(subscriptionTags.tagId, tagId));

  // Publish tag deleted event for multi-tab/device sync (fire and forget)
  publishTagDeleted(userId, tagId, deleted[0].updatedAt).catch(() => {
    // Ignore publish errors - SSE is best-effort
  });
}
