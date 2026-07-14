/**
 * Entry Filters Service
 *
 * Shared filter builder for entry queries. Used by listEntries, searchEntries,
 * countEntries, and markAllRead.
 */

import { eq, and, isNull, notInArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
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
  showSpam: boolean;
}

/**
 * Type for subscription IDs condition that can be used with inArray.
 * This is either a string array (for the single-subscription filter) or a
 * Drizzle subquery (for tag or uncategorized filters) — subqueries implement
 * SQLWrapper, which is what inArray accepts.
 */
type SubscriptionIdsCondition = string[] | SQLWrapper;

/**
 * Result of building entry subscription filters.
 *
 * Entries are attributed to exactly one subscription via
 * `user_entries.subscription_id` (surfaced as `visible_entries.subscription_id`),
 * which survives feed redirects/merges via the merge-job re-stamp — so
 * subscription-ID filtering always agrees with what the visibility view
 * attributes.
 *
 * @property subscriptionIdsCondition - Either an array of subscription IDs, a
 *                                      subquery that returns subscription IDs,
 *                                      or null if no subscription filter is needed
 * @property isEmpty - True if the filter conditions result in no possible matches
 *                    (e.g., invalid subscription ID, non-existent tag)
 */
export interface EntryFilterResult {
  subscriptionIdsCondition: SubscriptionIdsCondition | null;
  isEmpty: boolean;
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
 * Builds subscription filter conditions for entry queries.
 *
 * This function handles the three main subscription-based filters:
 * 1. subscriptionId - Filter to entries attributed to a specific subscription
 * 2. tagId - Filter to entries attributed to tagged subscriptions
 * 3. uncategorized - Filter to entries attributed to untagged subscriptions
 *
 * @param db - Database instance
 * @param params - Filter parameters
 * @param userId - User ID for ownership validation
 * @returns Filter result with subscriptionIdsCondition and isEmpty flag
 */
export async function buildEntrySubscriptionFilter(
  db: typeof dbType,
  params: EntryFilterParams,
  userId: string
): Promise<EntryFilterResult> {
  // Filter by subscriptionId - validates ownership, early-exits when invalid
  if (params.subscriptionId) {
    const owned = await verifySubscriptionOwnership(db, params.subscriptionId, userId);
    if (!owned) {
      return { subscriptionIdsCondition: null, isEmpty: true };
    }
    return { subscriptionIdsCondition: [params.subscriptionId], isEmpty: false };
  }

  // Filter by tagId - uses join to validate tag ownership, returns subquery
  // The subquery will return no rows if the tag doesn't exist or belongs to another user
  if (params.tagId) {
    const taggedSubscriptionIds = buildTaggedSubscriptionIdsSubquery(db, params.tagId, userId);
    return { subscriptionIdsCondition: taggedSubscriptionIds, isEmpty: false };
  }

  // Filter by uncategorized - returns subquery
  if (params.uncategorized) {
    const uncategorizedSubscriptionIds = buildUncategorizedSubscriptionIdsSubquery(db, userId);
    return { subscriptionIdsCondition: uncategorizedSubscriptionIds, isEmpty: false };
  }

  // No subscription filter needed
  return { subscriptionIdsCondition: null, isEmpty: false };
}

// ============================================================================
// Entry Condition Builder
// ============================================================================

/**
 * Builds shared filter conditions for entry queries (unreadOnly, starredOnly,
 * type, excludeTypes, showSpam). Used by listEntries, searchEntries, and
 * countEntries to avoid duplicating the same filter logic.
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

  return conditions;
}

/**
 * Builds a condition that filters entries to those whose URL hostname matches
 * `domainName` (case-insensitive), backing the Wallabag `domain_name` query
 * parameter.
 *
 * Postgres has no URL parser, so we pull the authority host out of the URL with
 * a POSIX regex and `substring(... from pattern)` returns the first *capturing*
 * group. The pattern reproduces `new URL().hostname` semantics — which is what
 * `extractDomain` uses for the entry's reported `domain_name`, so the filter and
 * the reported field agree:
 *   `scheme://` then optional userinfo `(?:...@)?` (dropped, matching hostname)
 *   then the host — either a bracketed IPv6 literal `[...]` (brackets kept, as
 *   hostname does) or a reg-name/IPv4 up to the first `:`/`/`/`?`/`#` (so the
 *   port is dropped). A URL that fails to match (or a NULL url) yields NULL,
 *   which the `=` comparison drops — the correct behavior for a domain filter.
 *
 * The `\[`/`\]` bracket escapes are doubled (`\\[`, `\\]`) because a JS template
 * literal collapses `\[` to `[` before Postgres ever sees the pattern.
 */
export function buildDomainNameCondition(domainName: string): SQL {
  return sql`lower(substring(${visibleEntries.url} from '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/?#@]*@)?(\\[[^\\]]+\\]|[^/:?#]+)')) = lower(${domainName})`;
}
