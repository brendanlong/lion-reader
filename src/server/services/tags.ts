/**
 * Tags Service
 *
 * Business logic for tag operations. Used by both tRPC routers and MCP server.
 */

import { eq, and, sql, isNull } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import {
  tags,
  subscriptionTags,
  subscriptions,
  visibleEntries,
  userFeeds,
} from "@/server/db/schema";
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
// Helper: Per-Tag Unread Counts
// ============================================================================

/**
 * Builds a grouped subquery of per-tag unread counts for a user.
 *
 * Counts through visible_entries so the visibility rule (and the
 * subscription_feeds mapping that lets a subscription own entries under
 * multiple feed_ids after a redirect/merge) lives in one place. Filtering
 * read=false in WHERE lets the partial idx_user_entries_unread index drive.
 *
 * The inner join to user_feeds (active subscriptions only) scopes the count to
 * active subscriptions: visible_entries also surfaces starred entries from
 * unsubscribed feeds, which belong to Starred, not to a tag's unread badge.
 *
 * COUNT(DISTINCT id) dedupes entries reachable through multiple subscriptions
 * of the same tag (possible when subscription_feeds rows overlap). Computing
 * all tags in one grouped aggregation (instead of a correlated subquery per
 * tag row) keeps listTags to a single scan (#831); updateTag reuses this for
 * a single tag by filtering on tag_id.
 */
function tagUnreadCountsQuery(db: typeof dbType, userId: string) {
  return db
    .select({
      tagId: subscriptionTags.tagId,
      unreadCount: sql<number>`COUNT(DISTINCT ${visibleEntries.id})::int`.as("unread_count"),
    })
    .from(visibleEntries)
    .innerJoin(userFeeds, eq(userFeeds.id, visibleEntries.subscriptionId))
    .innerJoin(subscriptionTags, eq(subscriptionTags.subscriptionId, visibleEntries.subscriptionId))
    .where(and(eq(visibleEntries.userId, userId), eq(visibleEntries.read, false)))
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
    // Uncategorized unread count: unread visible entries whose (active)
    // subscription has no tags. Driving from visible_entries (read=false in
    // WHERE) lets the partial unread index scan ~unread rows instead of every
    // entry in every uncategorized feed. The inner join to user_feeds scopes to
    // active subscriptions, excluding starred orphans (entries kept visible
    // after unsubscribe), which aren't "uncategorized". COUNT(DISTINCT id)
    // guards against an entry mapping to multiple subscriptions via
    // subscription_feeds overlap.
    db
      .select({ unreadCount: sql<number>`COUNT(DISTINCT ${visibleEntries.id})::int` })
      .from(visibleEntries)
      .innerJoin(userFeeds, eq(userFeeds.id, visibleEntries.subscriptionId))
      .where(
        and(
          eq(visibleEntries.userId, userId),
          eq(visibleEntries.read, false),
          sql`NOT EXISTS (
            SELECT 1 FROM ${subscriptionTags}
            WHERE ${subscriptionTags.subscriptionId} = ${visibleEntries.subscriptionId}
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
