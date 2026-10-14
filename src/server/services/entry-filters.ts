/**
 * Entry Filters Service
 *
 * Shared filter builder and select fragments for entry queries. Used by
 * listEntries, searchEntries, countTotalEntries, and markAllRead.
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
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import type { db as dbType } from "@/server/db";
import {
  feeds,
  subscriptionEntries,
  subscriptionTags,
  subscriptions,
  tags,
  userEntries,
  visibleEntries,
} from "@/server/db/schema";
import { isListedSubscription } from "@/server/services/subscriptions";
import { SAVED_ARTICLES_TITLE, type EntryType } from "@/lib/entry-types";

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
  type?: EntryType;
  excludeTypes?: EntryType[];
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
 * never show the original name. An email's comes from its subscription
 * (#1846), and saved articles all show "Saved Articles". The query must LEFT
 * JOIN `feeds` on the entry's owner feed and `subscriptions` on its origin
 * ({@link entryMemberships}).
 */
export function entryFeedTitleSql(): SQL<string | null> {
  return sql<
    string | null
  >`CASE WHEN ${subscriptions.type} = 'saved' THEN ${SAVED_ARTICLES_TITLE}::text
    ELSE COALESCE(${subscriptions.customTitle}, ${feeds.title}) END`;
}

const membership = alias(subscriptionEntries, "membership");
const membershipSubscription = alias(subscriptions, "membership_subscription");

/**
 * An entry's memberships (#1846), read once per row as a LATERAL subquery
 * over `idx_subscription_entries_user_entry`, so use it on pages, not scans:
 *
 * - `originId`, the entry's **origin**: its membership in a web, email or
 *   saved subscription (never a collection), an active one first, then the
 *   newest. Clients' single `subscriptionId`, Google Reader's origin stream
 *   and the custom title come from it: LEFT JOIN `subscriptions` on
 *   {@link entryOriginOn}.
 * - `subscriptionIds`, the active subscriptions holding it: its origin, its
 *   collections and, for a saved article, the saved subscription. Sorted.
 *
 * Join it with `leftJoinLateral(memberships, sql\`true\`)` to a per-user
 * entry row (`visible_entries` or `user_entries`).
 */
export function entryMemberships(row: { userId: AnyColumn; entryId: AnyColumn }) {
  return new QueryBuilder()
    .select({
      originId: sql<string | null>`(array_agg(${membership.subscriptionId}
        ORDER BY ${membershipSubscription.unsubscribedAt} IS NULL DESC, ${membership.subscriptionId} DESC)
        FILTER (WHERE ${membershipSubscription.type} <> 'collection'))[1]`.as("origin_id"),
      subscriptionIds: sql<string[]>`COALESCE(array_agg(${membership.subscriptionId}::text
        ORDER BY ${membership.subscriptionId})
        FILTER (WHERE ${membershipSubscription.unsubscribedAt} IS NULL), '{}')`.as(
        "subscription_ids"
      ),
    })
    .from(membership)
    .innerJoin(membershipSubscription, eq(membershipSubscription.id, membership.subscriptionId))
    .where(and(eq(membership.userId, row.userId), eq(membership.entryId, row.entryId)))
    .as("entry_memberships");
}

/**
 * Joins `subscriptions` to the origin {@link entryMemberships} found, scoped
 * to the row's user so it can never reach another user's subscription.
 */
export function entryOriginOn(
  memberships: ReturnType<typeof entryMemberships>,
  row: { userId: AnyColumn }
): SQL {
  return and(eq(subscriptions.id, memberships.originId), eq(subscriptions.userId, row.userId))!;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * The `subscriptions` row a `subscriptionId` filter accepts: the user's,
 * active and listed (the saved subscription isn't a filter: Saved is
 * `type: "saved"`). The list (`verifySubscriptionOwnership`) and its badge
 * (`countEntries`) both use it, so they accept the same subscriptions.
 */
export function filterableSubscriptionWhere(userId: string, subscriptionId: string): SQL {
  return and(
    eq(subscriptions.id, subscriptionId),
    eq(subscriptions.userId, userId),
    isNull(subscriptions.unsubscribedAt),
    isListedSubscription()
  )!;
}

/**
 * Verifies the user may filter by a subscription (`filterableSubscriptionWhere`).
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
    .where(filterableSubscriptionWhere(userId, subscriptionId))
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
 * appears once and the query needs no `DISTINCT`. A subquery of ids (a tag's,
 * Uncategorized's) is read once per statement, as an `ARRAY(...)`, not again
 * for every row probed.
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
        AND ${
          Array.isArray(subscriptionIds)
            ? inArray(subscriptionEntries.subscriptionId, subscriptionIds)
            : sql`${subscriptionEntries.subscriptionId} = ANY(ARRAY(${subscriptionIds}))`
        }${paged ? sql` OFFSET 0` : sql``})`
  );
}

/**
 * Entries in the user's saved subscription (the Saved list, `type: "saved"`).
 */
export function inSavedSubscriptionSql(columns: { userId: AnyColumn; entryId: AnyColumn }): SQL {
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
 * searchEntries and countTotalEntries to avoid duplicating the
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

/**
 * The `visible_entries` view's predicate over `user_entries` (#1846): starred,
 * or in an active subscription. For queries that start from `user_entries`
 * rather than the view; a test holds the two to the same rows.
 */
export function visibleUserEntrySql(): SQL {
  return sql`(${userEntries.starred} = true OR ${userEntries.activeMemberships} > 0)`;
}
