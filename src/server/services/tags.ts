/**
 * Tags Service
 *
 * Business logic for tag operations. Used by both tRPC routers and MCP server.
 */

import { eq, and, ne, sql, isNull, inArray, type SQL } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { tags, subscriptionTags, subscriptions, users } from "@/server/db/schema";
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
// Service Functions
// ============================================================================

/**
 * Lists all tags for a user with feed counts and unread counts.
 * Also returns uncategorized subscription counts.
 */
export async function listTags(db: typeof dbType, userId: string): Promise<ListTagsResult> {
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
        unreadCount: tags.unreadCount,
      })
      .from(tags)
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
    db
      .select({ unreadCount: users.uncategorizedUnreadCount })
      .from(users)
      .where(eq(users.id, userId)),
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

/** Tag names are unique per user ignoring case, among live (not deleted) tags. */
export function tagNameMatches(name: string): SQL {
  return sql`lower(${tags.name}) = lower(${name})`;
}

export interface CreateTagResult {
  tag: Tag;
  /** False when a live tag with this name (ignoring case) already existed; it's returned unchanged. */
  created: boolean;
}

/**
 * Creates a tag, or returns the user's existing tag with that name (ignoring
 * case), so retried and concurrent creates are harmless.
 */
export async function createTag(
  db: typeof dbType,
  userId: string,
  params: CreateTagParams
): Promise<CreateTagResult> {
  // An existing tag can be deleted between the conflicting insert and the
  // lookup; then the next insert succeeds.
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = new Date();
    const [createdTag] = await db
      .insert(tags)
      .values({
        id: generateUuidv7(),
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

    if (createdTag) {
      publishTagCreated(
        userId,
        { id: createdTag.id, name: createdTag.name, color: createdTag.color },
        createdTag.updatedAt
      ).catch(() => {
        // Ignore publish errors - SSE is best-effort
      });
      return {
        tag: {
          id: createdTag.id,
          name: createdTag.name,
          color: createdTag.color,
          feedCount: 0,
          unreadCount: 0,
          createdAt: createdTag.createdAt,
        },
        created: true,
      };
    }

    const existing = await selectTagWithCounts(
      db,
      and(eq(tags.userId, userId), tagNameMatches(params.name), isNull(tags.deletedAt))!
    );
    if (existing) {
      return { tag: toTag(existing), created: false };
    }
  }
  throw errors.tagNameTaken();
}

/**
 * Updates an existing tag.
 *
 * @throws tagNotFound if tag doesn't exist or doesn't belong to user
 * @throws tagNameTaken if another of the user's tags has the new name (ignoring case)
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

  // Check for duplicates among *live* tags only, so this fails with a clear
  // error up front; the unique index decides races (caught below). A tag may
  // be renamed to a different capitalization of its own name.
  if (params.name !== undefined && params.name !== existingTag[0].name) {
    const duplicateName = await db
      .select({ id: tags.id })
      .from(tags)
      .where(
        and(
          eq(tags.userId, userId),
          tagNameMatches(params.name),
          isNull(tags.deletedAt),
          ne(tags.id, tagId)
        )
      )
      .limit(1);

    if (duplicateName.length > 0) {
      throw errors.tagNameTaken();
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

  try {
    // Scope the UPDATE by userId too — the ownership SELECT above already
    // guarantees it, but keeping the predicate here makes the mutation
    // self-evidently user-scoped in isolation (defense-in-depth).
    await db
      .update(tags)
      .set(updateData)
      .where(and(eq(tags.id, tagId), eq(tags.userId, userId)));
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw errors.tagNameTaken();
    }
    throw err;
  }

  const tag = await selectTagWithCounts(db, and(eq(tags.id, tagId), eq(tags.userId, userId))!);
  if (!tag) {
    throw errors.tagNotFound();
  }

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

  return toTag(tag);
}

async function selectTagWithCounts(db: typeof dbType, where: SQL) {
  const [tag] = await db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      createdAt: tags.createdAt,
      updatedAt: tags.updatedAt,
      unreadCount: tags.unreadCount,
      feedCount: sql<number>`count(${subscriptionTags.subscriptionId})::int`,
    })
    .from(tags)
    .leftJoin(subscriptionTags, eq(subscriptionTags.tagId, tags.id))
    .where(where)
    .groupBy(tags.id)
    .limit(1);
  return tag;
}

function toTag(tag: NonNullable<Awaited<ReturnType<typeof selectTagWithCounts>>>): Tag {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    feedCount: tag.feedCount,
    unreadCount: tag.unreadCount,
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
    // Associations first (scoped to the user's live tag): removing them
    // recomputes the user's counters, which locks the users row before the
    // tags rows, and tombstoning the tag first would invert that order.
    // They aren't synced, so a hard delete is fine.
    await tx.delete(subscriptionTags).where(
      and(
        eq(subscriptionTags.tagId, tagId),
        inArray(
          subscriptionTags.tagId,
          tx
            .select({ id: tags.id })
            .from(tags)
            .where(and(eq(tags.id, tagId), eq(tags.userId, userId), isNull(tags.deletedAt)))
        )
      )
    );

    const deleted = await tx
      .update(tags)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(tags.id, tagId), eq(tags.userId, userId), isNull(tags.deletedAt)))
      .returning({ id: tags.id, updatedAt: tags.updatedAt });

    if (deleted.length === 0) {
      throw errors.tagNotFound();
    }

    return deleted[0].updatedAt;
  });

  // Publish tag deleted event for multi-tab/device sync (fire and forget)
  publishTagDeleted(userId, tagId, updatedAt).catch(() => {
    // Ignore publish errors - SSE is best-effort
  });
}
