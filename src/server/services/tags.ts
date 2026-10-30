/**
 * Tags Service
 *
 * Business logic for tag operations. Used by both tRPC routers and MCP server.
 */

import { z } from "zod";
import { eq, and, or, sql, isNull, inArray, type SQL } from "drizzle-orm";
import { countsAsOfSchema } from "@/lib/events/schemas";
import type { db as dbType, DbOrTx } from "@/server/db";
import { tags, subscriptionTags, subscriptions, users } from "@/server/db/schema";
import { errors } from "@/server/errors";
import { isUniqueViolation } from "@/server/db/errors";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  isUserManagedSubscription,
  lockSubscriptionMembers,
} from "@/server/services/subscriptions";
import { publishUserEvent } from "@/server/redis/pubsub";
import { toSyncTag } from "@/server/services/subscription-sync-events";
import {
  countsAsOfColumn,
  countsAsOfNow,
  earliestCountsAsOf,
  formatCountsAsOf,
} from "@/server/services/counts";

// ============================================================================
// Types
// ============================================================================

export const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
  feedCount: z.number(),
  unreadCount: z.number(),
  createdAt: z.date(),
});

export type Tag = z.infer<typeof tagSchema>;

export const listTagsResultSchema = z.object({
  items: z.array(tagSchema),
  uncategorized: z.object({ feedCount: z.number(), unreadCount: z.number() }),
  /** When the unread counts were read. */
  asOf: countsAsOfSchema,
});

type ListTagsResult = z.infer<typeof listTagsResultSchema>;

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
        asOf: countsAsOfColumn(),
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
          isUserManagedSubscription(),
          sql`NOT EXISTS (
            SELECT 1 FROM ${subscriptionTags}
            WHERE ${subscriptionTags.subscriptionId} = ${subscriptions.id}
          )`
        )
      ),
    db
      .select({ unreadCount: users.uncategorizedUnreadCount, asOf: countsAsOfColumn() })
      .from(users)
      .where(eq(users.id, userId)),
  ]);

  const stamps = [...uncategorizedUnread, ...userTags.slice(0, 1)].map((row) => row.asOf);
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
    asOf: formatCountsAsOf(
      stamps.length > 0 ? earliestCountsAsOf(...stamps) : await countsAsOfNow(db)
    ),
  };
}

export const TAG_NAME_MAX_LENGTH = 50;

/** Trims a tag name and checks it's within the limits every surface shares. */
function validTagName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw errors.validation("Tag name is required");
  }
  if (trimmed.length > TAG_NAME_MAX_LENGTH) {
    throw errors.validation(`Tag name must be at most ${TAG_NAME_MAX_LENGTH} characters`);
  }
  return trimmed;
}

/**
 * Fits a name from an outside source (an OPML folder) to the tag-name limits
 * by trimming and truncating it, or null if nothing is left.
 */
export function fitTagName(name: string): string | null {
  let fitted = "";
  for (const char of name.trim()) {
    if (fitted.length + char.length > TAG_NAME_MAX_LENGTH) break;
    fitted += char;
  }
  return fitted.trimEnd() || null;
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
  const name = validTagName(params.name);
  // An existing tag can be deleted between the conflicting insert and the
  // lookup; then the next insert succeeds.
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = new Date();
    const [createdTag] = await db
      .insert(tags)
      .values({
        id: generateUuidv7(),
        userId,
        name,
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
      publishUserEvent({
        type: "tag_created",
        userId,
        tag: toSyncTag(createdTag),
        updatedAt: createdTag.updatedAt,
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
      eq(tags.userId, userId),
      tagNameMatches(name),
      isNull(tags.deletedAt)
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
  const name = params.name === undefined ? undefined : validTagName(params.name);
  const live = [eq(tags.id, tagId), eq(tags.userId, userId), isNull(tags.deletedAt)];
  const changes = [
    name === undefined ? undefined : sql`${tags.name} IS DISTINCT FROM ${name}`,
    params.color === undefined ? undefined : sql`${tags.color} IS DISTINCT FROM ${params.color}`,
  ].filter((change) => change !== undefined);

  let changed = false;
  if (changes.length > 0) {
    try {
      // The unique index decides a name clash, ignoring case, among live tags.
      const updated = await db
        .update(tags)
        .set({ name, color: params.color, updatedAt: new Date() })
        .where(and(...live, or(...changes)))
        .returning({ id: tags.id });
      changed = updated.length > 0;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw errors.tagNameTaken();
      }
      throw err;
    }
  }

  const tag = await selectTagWithCounts(db, ...live);
  if (!tag) {
    throw errors.tagNotFound();
  }

  if (changed) {
    publishUserEvent({
      type: "tag_updated",
      userId,
      tag: toSyncTag(tag),
      updatedAt: tag.updatedAt,
    });
  }

  return toTag(tag);
}

async function selectTagWithCounts(db: typeof dbType, ...conditions: SQL[]) {
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
    .where(and(...conditions))
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
 * Serializes, per user, changing which subscriptions their tags hold with
 * deleting a tag (`setTags`, `deleteTag`), so a tag is never linked while it's
 * being deleted. An advisory lock taken first rather than a row lock, so it
 * stays out of the row lock order in `src/server/CLAUDE.md`; its two-key form
 * keeps it apart from the subscription-cap lock's one-key space.
 */
export async function lockUserTagLinks(tx: DbOrTx, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('tag_links'), hashtext(${userId}))`);
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
    // Before reading the tag's links, so none is added until the tombstone commits.
    await lockUserTagLinks(tx, userId);
    // The tagged subscriptions' members, then the subscriptions, in the lock
    // order: dropping the associations moves the members' tag rows
    // (tag_entries), and a membership added meanwhile must wait for that.
    const tagged = inArray(
      subscriptions.id,
      tx
        .select({ id: subscriptionTags.subscriptionId })
        .from(subscriptionTags)
        .where(eq(subscriptionTags.tagId, tagId))
    );
    await lockSubscriptionMembers(tx, userId, tagged);
    await tx
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), tagged))
      .orderBy(subscriptions.id)
      .for("no key update");
    // Then the associations (scoped to the user's live tag): removing them
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
  publishUserEvent({ type: "tag_deleted", userId, tagId, updatedAt });
}
