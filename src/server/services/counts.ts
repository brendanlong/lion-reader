/**
 * Entry Counts Service
 *
 * Provides queries for fetching unread counts related to entries.
 * Used by mutations and SSE events to return absolute counts for cache updates.
 *
 * Every unread badge is a trigger-maintained counter (spam excluded), read
 * directly — never a scan:
 *
 *   subscription  = subscriptions.unread_count (its unread memberships)
 *   tag           = tags.unread_count
 *   uncategorized = users.uncategorized_unread_count
 *   saved         = the saved subscription's unread_count
 *   starred       = users.starred_unread_count
 *   all           = users.all_unread_count
 *
 * Tag, Uncategorized and All count distinct articles: one reachable through
 * several subscriptions (#1806, #1846) counts once. The database functions
 * `apply_unread_memberships` and `recompute_list_counters` maintain them.
 */

import { eq, and, inArray, isNull, sql } from "drizzle-orm";
import type { z } from "zod";
import type { unreadCountsSchema } from "@/lib/events/schemas";
import { isUserManagedSubscription } from "./subscriptions";
import type { Temporal } from "temporal-polyfill";
import type { db as dbType } from "@/server/db";
import { parseTimestamptz } from "@/server/db/temporal";
import {
  subscriptionEntries,
  subscriptionTags,
  subscriptions,
  tags,
  users,
} from "@/server/db/schema";

// ============================================================================
// Types
// ============================================================================

/**
 * Tag unread count.
 */
export interface TagCount {
  id: string;
  unread: number;
}

// ============================================================================
// Count stamps
// ============================================================================

/**
 * Counts are read with the global `db`, never inside a transaction: a stamp
 * taken before the commit of the write it reflects would let an older read
 * stamped after it win on the client.
 */
type CountsDb = typeof dbType;

/**
 * A select column stamping the counts a statement reads (`countsAsOfSchema`).
 * Counts read by several statements take the earliest stamp
 * (`earliestCountsAsOf`): each value is at least that new.
 */
export function countsAsOfColumn() {
  return sql`statement_timestamp()`.mapWith(parseTimestamptz);
}

/** A stamp for counts read now that no statement read (a list that doesn't exist). */
export async function countsAsOfNow(db: CountsDb): Promise<Temporal.Instant> {
  const { rows } = await db.execute<{ as_of: string }>(sql`SELECT statement_timestamp() AS as_of`);
  return parseTimestamptz(rows[0].as_of);
}

export function earliestCountsAsOf(...stamps: Temporal.Instant[]): Temporal.Instant {
  return stamps.reduce((earliest, stamp) =>
    stamp.epochNanoseconds < earliest.epochNanoseconds ? stamp : earliest
  );
}

/** The wire form of a count stamp (`countsAsOfSchema`). */
export function formatCountsAsOf(stamp: Temporal.Instant): string {
  return stamp.toString({ fractionalSecondDigits: 6 });
}

// ============================================================================
// Service Functions
// ============================================================================

interface UserUnreadCounts {
  allUnread: number;
  starredUnread: number;
  savedUnread: number;
  uncategorizedUnread: number;
  asOf: Temporal.Instant;
}

export async function getUserUnreadCounts(db: CountsDb, userId: string): Promise<UserUnreadCounts> {
  const [row] = await db
    .select({
      allUnread: users.allUnreadCount,
      starredUnread: users.starredUnreadCount,
      // Saved is the saved subscription's count. Raw names: a single-table
      // select renders its columns unqualified, which the subquery would capture.
      savedUnread: sql<number>`COALESCE((
        SELECT s.unread_count FROM subscriptions s
        WHERE s.user_id = users.id AND s.type = 'saved'
      ), 0)`,
      uncategorizedUnread: users.uncategorizedUnreadCount,
      asOf: countsAsOfColumn(),
    })
    .from(users)
    .where(eq(users.id, userId));
  return (
    row ?? {
      allUnread: 0,
      starredUnread: 0,
      savedUnread: 0,
      uncategorizedUnread: 0,
      asOf: await countsAsOfNow(db),
    }
  );
}

/** Global unread counts (all + starred + saved) for a user. */
export async function getGlobalUnreadCounts(
  db: CountsDb,
  userId: string
): Promise<{ allUnread: number; starredUnread: number; savedUnread: number }> {
  const { allUnread, starredUnread, savedUnread } = await getUserUnreadCounts(db, userId);
  return { allUnread, starredUnread, savedUnread };
}

/**
 * Per-tag unread counts. Every requested tag is returned, zero-filled: the
 * client sets these counts absolutely, so an omitted tag would keep its stale
 * badge.
 */
async function getTagUnreadCounts(
  db: CountsDb,
  userId: string,
  tagIds: string[]
): Promise<TagCount[]> {
  if (tagIds.length === 0) {
    return [];
  }
  const tagCounts = await db
    .select({ tagId: tags.id, unread: tags.unreadCount })
    .from(tags)
    .where(and(eq(tags.userId, userId), inArray(tags.id, tagIds)));

  const unreadByTag = new Map(tagCounts.map((t) => [t.tagId, t.unread]));
  return tagIds.map((id) => ({ id, unread: unreadByTag.get(id) ?? 0 }));
}

/**
 * Counts for multiple entries, with subscription and tag counts aggregated.
 * Used by markRead, star/unstar, and new_entry events to return counts for all
 * affected lists.
 */
export type BulkUnreadCounts = z.infer<typeof unreadCountsSchema>;

/**
 * Fetches unread counts for multiple entries' lists.
 * Collects unique subscriptions and tags from the entries and returns counts for each.
 *
 * @param db - Database instance
 * @param userId - User ID
 * @param entries - Entries (by id: every subscription but Saved holding them),
 *   or subscriptions (by subscriptionId, for an entry-less change)
 * @param options.formerTagIds - The former tags of each subscription the change
 *   moved out of lists (empty: it was in Uncategorized), whose lists it also
 *   moved. Those associations are gone by then, so the caller says them.
 * @returns Aggregated unread counts for all affected lists
 */
export async function getBulkEntryRelatedCounts(
  db: CountsDb,
  userId: string,
  entries: Array<{ id?: string; subscriptionId: string | null }>,
  { formerTagIds = [] }: { formerTagIds?: string[][] } = {}
): Promise<BulkUnreadCounts> {
  const entryIds = entries.map((e) => e.id).filter((id) => id !== undefined);
  // The active subscriptions holding the entries (#1846) but Saved, whose
  // count is `saved`, and which is in no tag or Uncategorized.
  const memberOf =
    entryIds.length > 0
      ? (
          await db
            .selectDistinct({ id: subscriptionEntries.subscriptionId })
            .from(subscriptionEntries)
            .innerJoin(subscriptions, eq(subscriptions.id, subscriptionEntries.subscriptionId))
            .where(
              and(
                eq(subscriptionEntries.userId, userId),
                isNull(subscriptions.unsubscribedAt),
                isUserManagedSubscription(),
                // One array parameter: a mark-all-read can pass more ids than a
                // statement takes parameters.
                sql`${subscriptionEntries.entryId} = ANY(${`{${entryIds.join(",")}}`}::uuid[])`
              )
            )
        ).map((row) => row.id)
      : [];

  const subscriptionIds = [
    ...new Set([
      ...entries.flatMap((e) => (e.id === undefined && e.subscriptionId ? [e.subscriptionId] : [])),
      ...memberOf,
    ]),
  ];

  // The global counter arithmetic runs alongside the subscription counter and
  // tag lookups; the latter are skipped when only saved entries are affected.
  const [userCounts, subscriptionCounts, subTags] = await Promise.all([
    getUserUnreadCounts(db, userId),
    subscriptionIds.length > 0
      ? db
          .select({
            subscriptionId: subscriptions.id,
            unread: subscriptions.unreadCount,
            asOf: countsAsOfColumn(),
          })
          .from(subscriptions)
          .where(and(eq(subscriptions.userId, userId), inArray(subscriptions.id, subscriptionIds)))
      : Promise.resolve([]),
    subscriptionIds.length > 0
      ? db
          .select({
            subscriptionId: subscriptionTags.subscriptionId,
            tagId: subscriptionTags.tagId,
          })
          .from(subscriptionTags)
          .where(inArray(subscriptionTags.subscriptionId, subscriptionIds))
      : Promise.resolve([]),
  ]);

  // The tag counts below are read after both of these, so are at least as new.
  const baseCounts: BulkUnreadCounts = {
    all: { unread: userCounts.allUnread },
    starred: { unread: userCounts.starredUnread },
    saved: { unread: userCounts.savedUnread },
    subscriptions: [],
    tags: [],
    asOf: formatCountsAsOf(
      earliestCountsAsOf(userCounts.asOf, ...subscriptionCounts.slice(0, 1).map((s) => s.asOf))
    ),
  };

  // Zero-fill: a requested subscription the counter query didn't return (e.g.
  // deleted out from under us) must still appear — the client sets these
  // counts absolutely, so omitting a subscription would leave a stale badge.
  const unreadBySubscription = new Map(subscriptionCounts.map((s) => [s.subscriptionId, s.unread]));
  baseCounts.subscriptions = subscriptionIds.map((id) => ({
    id,
    unread: unreadBySubscription.get(id) ?? 0,
    tagIds: subTags.filter((t) => t.subscriptionId === id).map((t) => t.tagId),
  }));

  const tagIds = [...new Set([...subTags.map((t) => t.tagId), ...formerTagIds.flat()])];
  const subscriptionsWithTags = new Set(subTags.map((t) => t.subscriptionId));
  const hasUncategorized =
    subscriptionIds.some((id) => !subscriptionsWithTags.has(id)) ||
    formerTagIds.some((ids) => ids.length === 0);

  baseCounts.tags = await getTagUnreadCounts(db, userId, tagIds);
  if (hasUncategorized) {
    baseCounts.uncategorized = { unread: userCounts.uncategorizedUnread };
  }

  return baseCounts;
}
