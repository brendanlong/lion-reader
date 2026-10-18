/**
 * The admin feed-health list: every web feed in the system, not one user's.
 */

import { z } from "zod";
import { and, asc, count, desc, eq, gt, ilike, isNull, sql } from "drizzle-orm";
import type { Database } from "@/server/db";
import { entries, feeds, subscriptions } from "@/server/db/schema";
import { createCursorCodec, cursorUuid } from "@/server/services/cursor";

/** Keyset cursor matching the feed list's ORDER BY failures DESC, COALESCE(title, '') ASC, id ASC. */
const adminFeedCursor = createCursorCodec(
  z.object({
    failures: z.number().int(),
    title: z.string(),
    id: cursorUuid,
  })
);

interface ListAdminFeedsParams {
  limit: number;
  cursor?: string;
  /** Case-insensitive URL substring. */
  urlFilter?: string;
  /** Only feeds a user whose email contains this (case-insensitive) is subscribed to. */
  userEmail?: string;
  brokenOnly?: boolean;
  hasSubscribers?: boolean;
}

interface AdminFeed {
  feedId: string;
  title: string | null;
  url: string | null;
  siteUrl: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastFetchedAt: Date | null;
  lastEntriesUpdatedAt: Date | null;
  nextFetchAt: Date | null;
  websubActive: boolean;
  subscriberCount: number;
  lastFetchEntryCount: number | null;
  lastFetchSizeBytes: number | null;
  totalEntryCount: number;
  entriesPerWeek: number | null;
}

/** Lists feeds most-failing first, then by title. */
export async function listAdminFeeds(
  db: Database,
  { limit, cursor, urlFilter, userEmail, brokenOnly, hasSubscribers }: ListAdminFeedsParams
): Promise<{ items: AdminFeed[]; nextCursor?: string }> {
  // Subscriber count subquery
  const subscriberCountSq = db
    .select({ count: count().as("subscriber_count") })
    .from(subscriptions)
    .where(and(eq(subscriptions.feedId, feeds.id), isNull(subscriptions.unsubscribedAt)));

  // Total entry count subquery
  const totalEntryCountSq = db
    .select({ count: count().as("count") })
    .from(entries)
    .where(eq(entries.ownerFeedId, feeds.id));

  // Oldest entry timestamp subquery
  const oldestEntryAtSq = db
    .select({ minFetchedAt: sql`MIN(${entries.fetchedAt})`.as("min_fetched_at") })
    .from(entries)
    .where(eq(entries.ownerFeedId, feeds.id));

  // Entries per week: count / weeks since oldest entry
  const entriesPerWeekExpr = sql<number | null>`
    CASE
      WHEN (${totalEntryCountSq}) = 0 THEN NULL
      WHEN (${oldestEntryAtSq}) IS NULL THEN NULL
      WHEN EXTRACT(EPOCH FROM (NOW() - (${oldestEntryAtSq}))) < 604800 THEN NULL
      ELSE (${totalEntryCountSq})::float / (EXTRACT(EPOCH FROM (NOW() - (${oldestEntryAtSq}))) / 604800.0)
    END
  `;

  const conditions = [];

  // ORDER BY consecutiveFailures DESC, title ASC, id ASC. Tuple comparison
  // assumes uniform direction, so spell out the mixed-direction keyset.
  if (cursor) {
    const after = adminFeedCursor.decode(cursor);
    conditions.push(
      sql`(
        ${feeds.consecutiveFailures} < ${after.failures}
        OR (
          ${feeds.consecutiveFailures} = ${after.failures}
          AND (
            COALESCE(${feeds.title}, '') > ${after.title}
            OR (COALESCE(${feeds.title}, '') = ${after.title} AND ${feeds.id} > ${after.id})
          )
        )
      )`
    );
  }

  if (urlFilter) {
    conditions.push(ilike(feeds.url, `%${urlFilter}%`));
  }

  if (brokenOnly) {
    conditions.push(gt(feeds.consecutiveFailures, 0));
  }

  if (hasSubscribers) {
    conditions.push(sql`(${subscriberCountSq}) > 0`);
  }

  if (userEmail) {
    conditions.push(
      sql`${feeds.id} IN (
        SELECT s.feed_id FROM subscriptions s
        JOIN users u ON u.id = s.user_id
        WHERE u.email ILIKE ${`%${userEmail}%`}
          AND s.unsubscribed_at IS NULL
      )`
    );
  }

  const whereClause = and(...conditions);

  const rows = await db
    .select({
      feedId: feeds.id,
      title: feeds.title,
      url: feeds.url,
      siteUrl: feeds.siteUrl,
      consecutiveFailures: feeds.consecutiveFailures,
      lastError: feeds.lastError,
      lastFetchedAt: feeds.lastFetchedAt,
      lastEntriesUpdatedAt: feeds.lastEntriesUpdatedAt,
      nextFetchAt: feeds.nextFetchAt,
      websubActive: feeds.websubActive,
      subscriberCount: sql<number>`(${subscriberCountSq})`.as("subscriber_count"),
      lastFetchEntryCount: feeds.lastFetchEntryCount,
      lastFetchSizeBytes: feeds.lastFetchSizeBytes,
      totalEntryCount: sql<number>`(${totalEntryCountSq})`.as("total_entry_count"),
      entriesPerWeek: entriesPerWeekExpr.as("entries_per_week"),
    })
    .from(feeds)
    .where(whereClause)
    // Must match the cursor comparison above exactly: the cursor compares
    // COALESCE(title, ''), so ordering by the bare column (Postgres
    // `ASC` = NULLS LAST) would sort untitled feeds after every titled one
    // while the cursor sorts them first, making them unreachable past the
    // first page.
    .orderBy(desc(feeds.consecutiveFailures), sql`COALESCE(${feeds.title}, '') ASC`, asc(feeds.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const lastFeed = items[items.length - 1];
  const nextCursor = hasMore
    ? adminFeedCursor.encode({
        failures: lastFeed.consecutiveFailures,
        title: lastFeed.title ?? "",
        id: lastFeed.feedId,
      })
    : undefined;

  return {
    items: items.map((row) => ({
      ...row,
      subscriberCount: Number(row.subscriberCount),
      totalEntryCount: Number(row.totalEntryCount),
      entriesPerWeek: row.entriesPerWeek != null ? Number(row.entriesPerWeek) : null,
    })),
    nextCursor,
  };
}
