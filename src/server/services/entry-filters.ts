/**
 * Entry Filters Service
 *
 * Shared filter builder and select fragments for entry queries. Used by
 * listEntries, searchEntries, countEntries, and markAllRead.
 */

import {
  eq,
  and,
  exists,
  inArray,
  isNull,
  notInArray,
  sql,
  type AnyColumn,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import {
  feeds,
  subscriptionEntries,
  subscriptionTags,
  subscriptions,
  tags,
  visibleEntries,
} from "@/server/db/schema";
import { isListedSubscription } from "@/server/services/subscriptions";

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
  /**
   * Entries in at least one collection of every group (Wallabag's multi-tag
   * filter, which matches entries carrying all the tags). Callers pass
   * collection ids already checked to be the user's.
   */
  collectionIdGroups?: string[][];
  showSpam: boolean;
}

// ============================================================================
// Select Fragments
// ============================================================================

/**
 * An entry's source name as the user sees it: their custom title for the
 * entry's origin subscription, else the feed's title. Every read that sends
 * `feedTitle` to a client uses this, so a renamed subscription's articles
 * never show the original name. The query must join `feeds` on the entry's
 * feed and LEFT JOIN `subscriptions` on {@link entryOriginJoin}. Saved
 * articles get the saved feed's title, not the saved subscription's.
 */
export function entryFeedTitleSql(): SQL<string | null> {
  return sql<
    string | null
  >`COALESCE(CASE WHEN ${subscriptions.type} <> 'saved' THEN ${subscriptions.customTitle} END, ${feeds.title})`;
}

/**
 * Joins `subscriptions` to a per-user entry row (`visible_entries` or
 * `user_entries`) on the entry's **origin** (#1846): its membership in a web,
 * email or saved subscription (never a collection), an active one first,
 * then the newest. Clients' single `subscriptionId`, Google Reader's origin
 * stream and the custom title come from it. Scoped to the row's user, so it
 * can never reach another user's subscription. Computed per row read (an
 * index lookup on `idx_subscription_entries_user_entry`), so use it on pages,
 * not scans.
 */
export function entryOriginJoin(row: { userId: AnyColumn; entryId: AnyColumn }): SQL {
  return sql`${subscriptions.userId} = ${row.userId} AND ${subscriptions.id} = (
    SELECT se.subscription_id FROM subscription_entries se
    JOIN subscriptions os ON os.id = se.subscription_id
    WHERE se.user_id = ${row.userId} AND se.entry_id = ${row.entryId} AND os.type <> 'collection'
    ORDER BY os.unsubscribed_at IS NULL DESC, se.subscription_id DESC
    LIMIT 1)`;
}

/**
 * The active subscriptions holding an entry (#1846): its origin, its
 * collections and, for a saved article, the saved subscription. Sorted.
 */
export function entrySubscriptionIdsSql(row: {
  userId: AnyColumn;
  entryId: AnyColumn;
}): SQL<string[]> {
  return sql<string[]>`ARRAY(
    SELECT se.subscription_id::text FROM subscription_entries se
    JOIN subscriptions ms ON ms.id = se.subscription_id AND ms.unsubscribed_at IS NULL
    WHERE se.user_id = ${row.userId} AND se.entry_id = ${row.entryId}
    ORDER BY se.subscription_id)`;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Verifies a subscription exists, is active, belongs to the user and is listed
 * (the saved subscription isn't a filter: Saved is `type: "saved"`).
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
        isNull(subscriptions.unsubscribedAt),
        isListedSubscription()
      )
    )
    .limit(1);
  return subExists.length > 0;
}

/**
 * Builds a subquery for the active subscription IDs associated with a tag.
 * The join with tags table ensures the tag belongs to the user (and is not
 * soft-deleted), eliminating the need for a separate tag ownership validation
 * query. Excluding tombstoned tags means a client can't filter/mark-read
 * entries through a tag that no longer appears in listTags. Active only, like
 * the tag's badge: an unsubscribed feed's starred leftovers belong to
 * Starred, not the tag.
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
    .innerJoin(
      subscriptions,
      and(
        eq(subscriptions.id, subscriptionTags.subscriptionId),
        isNull(subscriptions.unsubscribedAt)
      )
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
        isListedSubscription(),
        isNull(subscriptionTags.subscriptionId)
      )
    );
}

/**
 * Matches entries contained in any of the given subscriptions: one `EXISTS`
 * over their memberships (#1846), so an entry in several of them still
 * appears once and the query needs no `DISTINCT`.
 *
 * `paged` keeps it a per-row lookup (`OFFSET 0` stops Postgres turning it into
 * a semi-join) for a page read newest first: walking the user's timeline stops
 * after a page, while a semi-join reads every member of a tag's subscriptions
 * first and sorts them. Counts and bulk updates, which read every match, leave
 * the choice to the planner.
 */
export function buildEntriesInSubscriptionsCondition(
  subscriptionIds: string[] | SQLWrapper,
  columns: { userId: AnyColumn; entryId: AnyColumn },
  { paged = false }: { paged?: boolean } = {}
): SQL {
  return exists(
    sql`(SELECT 1 FROM ${subscriptionEntries}
      WHERE ${subscriptionEntries.userId} = ${columns.userId}
        AND ${subscriptionEntries.entryId} = ${columns.entryId}
        AND ${inArray(subscriptionEntries.subscriptionId, subscriptionIds)}${paged ? sql` OFFSET 0` : sql``})`
  );
}

/**
 * Entries in the user's saved subscription (the Saved list, `type: "saved"`).
 */
function inSavedSubscriptionSql(columns: { userId: AnyColumn; entryId: AnyColumn }): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${subscriptionEntries}
    JOIN ${subscriptions} ON ${subscriptions.id} = ${subscriptionEntries.subscriptionId}
      AND ${subscriptions.type} = 'saved'
    WHERE ${subscriptionEntries.userId} = ${columns.userId}
      AND ${subscriptionEntries.entryId} = ${columns.entryId})`;
}

// ============================================================================
// Main Filter Builder
// ============================================================================

/**
 * Builds the subscription filter condition for entry queries.
 *
 * This function handles the three main subscription-based filters:
 * 1. subscriptionId - Filter to entries in a specific subscription
 * 2. tagId - Filter to entries in tagged subscriptions
 * 3. uncategorized - Filter to entries in untagged subscriptions
 *
 * Each matches the entries those subscriptions hold (their memberships), so a
 * collection lists its members and a feed the articles it kept after a merge.
 *
 * @returns The condition to AND into the query, `undefined` when no subscription
 *          filter applies, or `null` when nothing can match (e.g. a subscription
 *          the user doesn't own)
 */
export async function buildEntrySubscriptionFilter(
  db: typeof dbType,
  params: EntryFilterParams,
  userId: string,
  options: { paged?: boolean } = {}
): Promise<SQL | undefined | null> {
  // Filter by subscriptionId - validates ownership, early-exits when invalid
  const columns = { userId: visibleEntries.userId, entryId: visibleEntries.id };
  if (params.subscriptionId) {
    const owned = await verifySubscriptionOwnership(db, params.subscriptionId, userId);
    return owned
      ? buildEntriesInSubscriptionsCondition([params.subscriptionId], columns, options)
      : null;
  }

  // Filter by tagId - uses join to validate tag ownership, returns subquery
  // The subquery will return no rows if the tag doesn't exist or belongs to another user
  if (params.tagId) {
    return buildEntriesInSubscriptionsCondition(
      buildTaggedSubscriptionIdsSubquery(db, params.tagId, userId),
      columns,
      options
    );
  }

  if (params.uncategorized) {
    return buildEntriesInSubscriptionsCondition(
      buildUncategorizedSubscriptionIdsSubquery(db, userId),
      columns,
      options
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

  if (params.type === "saved") {
    // Saved is the saved subscription's list.
    conditions.push(
      inSavedSubscriptionSql({ userId: visibleEntries.userId, entryId: visibleEntries.id })
    );
  } else if (params.type) {
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

  for (const group of params.collectionIdGroups ?? []) {
    conditions.push(
      buildEntriesInSubscriptionsCondition(group, {
        userId: visibleEntries.userId,
        entryId: visibleEntries.id,
      })
    );
  }

  return conditions;
}
