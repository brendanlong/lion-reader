/**
 * Entry Filters Service
 *
 * Shared filter builder for entry queries. Used by listEntries, searchEntries,
 * countEntries, and markAllRead.
 */

import { eq, and, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { subscriptionTags, subscriptions, tags, visibleEntries } from "@/server/db/schema";

// ============================================================================
// Types
// ============================================================================

export interface EntryFilterParams {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
}

export interface EntryConditionParams {
  unreadOnly?: boolean;
  readOnly?: boolean;
  starredOnly?: boolean;
  unstarredOnly?: boolean;
  type?: "web" | "email" | "saved";
  excludeTypes?: Array<"web" | "email" | "saved">;
  publishedAfter?: Date;
  publishedBefore?: Date;
  updatedAfter?: Date;
  showSpam: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Verifies a subscription exists, is active, and belongs to the user.
 * Queries the subscriptions table directly — the user_feeds view is
 * display-only (subscription list surfaces), not for ownership checks.
 */
export async function verifySubscriptionOwnership(
  db: typeof dbType,
  subscriptionId: string,
  userId: string
): Promise<boolean> {
  const subExists = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.id, subscriptionId),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt)
      )
    )
    .limit(1);
  return subExists.length > 0;
}

/**
 * Builds a subquery for subscription IDs associated with a tag.
 * The join with tags table ensures the tag belongs to the user (and is not
 * soft-deleted), eliminating the need for a separate tag ownership validation
 * query. Excluding tombstoned tags means a client can't filter/mark-read
 * entries through a tag that no longer appears in listTags.
 */
export function buildTaggedSubscriptionIdsSubquery(
  db: typeof dbType,
  tagId: string,
  userId: string
) {
  return db
    .select({ subscriptionId: subscriptionTags.subscriptionId })
    .from(subscriptionTags)
    .innerJoin(
      tags,
      and(eq(subscriptionTags.tagId, tags.id), eq(tags.userId, userId), isNull(tags.deletedAt))
    )
    .where(eq(subscriptionTags.tagId, tagId));
}

/**
 * Builds a subquery for subscription IDs of uncategorized subscriptions.
 * Uses a LEFT JOIN anti-join pattern: active subscriptions with no matching
 * subscription_tags row are "uncategorized". Queries the subscriptions table
 * directly (the user_feeds view is display-only).
 *
 * Exported so markAllEntriesRead reuses the exact same definition rather than
 * reimplementing it (they must stay in sync).
 */
export function buildUncategorizedSubscriptionIdsSubquery(db: typeof dbType, userId: string) {
  return db
    .select({ subscriptionId: subscriptions.id })
    .from(subscriptions)
    .leftJoin(subscriptionTags, eq(subscriptionTags.subscriptionId, subscriptions.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        isNull(subscriptionTags.subscriptionId)
      )
    );
}

// ============================================================================
// Main Filter Builder
// ============================================================================

/**
 * Builds the subscription filter condition for entry queries.
 *
 * This function handles the three main subscription-based filters:
 * 1. subscriptionId - Filter to entries attributed to a specific subscription
 * 2. tagId - Filter to entries attributed to tagged subscriptions
 * 3. uncategorized - Filter to entries attributed to untagged subscriptions
 *
 * Entries are attributed to exactly one subscription via
 * `user_entries.subscription_id` (surfaced as `visible_entries.subscription_id`),
 * which survives feed redirects/merges via the merge-job re-stamp — so
 * subscription-ID filtering always agrees with what the visibility view
 * attributes.
 *
 * @returns The condition to AND into the query, `undefined` when no subscription
 *          filter applies, or `null` when nothing can match (e.g. a subscription
 *          the user doesn't own)
 */
export async function buildEntrySubscriptionFilter(
  db: typeof dbType,
  params: EntryFilterParams,
  userId: string
): Promise<SQL | undefined | null> {
  // Filter by subscriptionId - validates ownership, early-exits when invalid
  if (params.subscriptionId) {
    const owned = await verifySubscriptionOwnership(db, params.subscriptionId, userId);
    return owned ? inArray(visibleEntries.subscriptionId, [params.subscriptionId]) : null;
  }

  // Filter by tagId - uses join to validate tag ownership, returns subquery
  // The subquery will return no rows if the tag doesn't exist or belongs to another user
  if (params.tagId) {
    return inArray(
      visibleEntries.subscriptionId,
      buildTaggedSubscriptionIdsSubquery(db, params.tagId, userId)
    );
  }

  if (params.uncategorized) {
    return inArray(
      visibleEntries.subscriptionId,
      buildUncategorizedSubscriptionIdsSubquery(db, userId)
    );
  }

  return undefined;
}

// ============================================================================
// Entry Condition Builder
// ============================================================================

/**
 * Builds shared filter conditions for entry queries (unreadOnly, starredOnly,
 * type, excludeTypes, showSpam, timestamp bounds). Used by listEntries,
 * searchEntries, countEntries, and countTotalEntries to avoid duplicating the
 * same filter logic.
 */
export function buildEntryFilterConditions(params: EntryConditionParams): SQL[] {
  const conditions: SQL[] = [];

  if (params.unreadOnly) {
    conditions.push(eq(visibleEntries.read, false));
  } else if (params.readOnly) {
    conditions.push(eq(visibleEntries.read, true));
  }

  if (params.starredOnly) {
    conditions.push(eq(visibleEntries.starred, true));
  } else if (params.unstarredOnly) {
    conditions.push(eq(visibleEntries.starred, false));
  }

  if (params.type) {
    conditions.push(eq(visibleEntries.type, params.type));
  }

  if (params.excludeTypes && params.excludeTypes.length > 0) {
    conditions.push(notInArray(visibleEntries.type, params.excludeTypes));
  }

  if (!params.showSpam) {
    conditions.push(eq(visibleEntries.isSpam, false));
  }

  // Timestamp filters (used by Google Reader API ot/nt parameters).
  // publishedOrFetchedAt is the denormalized COALESCE(publishedAt, fetchedAt).
  if (params.publishedAfter) {
    conditions.push(sql`${visibleEntries.publishedOrFetchedAt} >= ${params.publishedAfter}`);
  }
  if (params.publishedBefore) {
    conditions.push(sql`${visibleEntries.publishedOrFetchedAt} <= ${params.publishedBefore}`);
  }
  // "Modified since" filter (Wallabag `since` delta sync). visibleEntries.updatedAt is
  // GREATEST(entry.updated_at, user_entries.updated_at), so this captures new saves,
  // content refetches, AND read/star state changes — the same value we return as the
  // entry's updated_at, so the filter and the reported timestamp can't disagree.
  //
  // The GREATEST spans two tables so no single index covers it — but here it is only
  // a RESIDUAL filter, not the sort key: listEntries still sorts by
  // publishedOrFetchedAt (idx_user_entries_published_or_fetched) with LIMIT
  // pushdown. The Wallabag caller also scopes to type='saved', so the scan is
  // bounded to the user's read-it-later library, not the whole timeline. That keeps
  // the #1105 problem (a mandatory full sort of the user's entire history) from
  // applying, so this deliberately stays a simple residual filter.
  if (params.updatedAfter) {
    conditions.push(sql`${visibleEntries.updatedAt} >= ${params.updatedAfter}`);
  }

  return conditions;
}
