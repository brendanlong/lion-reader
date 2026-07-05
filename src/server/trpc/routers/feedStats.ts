/**
 * Feed Stats Router
 *
 * Provides endpoints for viewing feed fetch statistics for subscribed feeds.
 * Shows last fetch times, next scheduled fetches, error states, and WebSub status.
 * Supports cursor-based pagination for large subscription lists.
 */

import { z } from "zod";
import { eq, and, isNull, sql, count } from "drizzle-orm";

import { createTRPCRouter, confirmedProtectedProcedure as protectedProcedure } from "../trpc";
import { feeds, subscriptions, entries } from "@/server/db/schema";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Feed stats output schema - what we return for each feed's statistics.
 */
const feedStatsOutputSchema = z.object({
  feedId: z.string(),
  subscriptionId: z.string(),
  title: z.string().nullable(),
  customTitle: z.string().nullable(),
  url: z.string().nullable(),
  siteUrl: z.string().nullable(),
  lastFetchedAt: z.date().nullable(),
  lastEntriesUpdatedAt: z.date().nullable(),
  nextFetchAt: z.date().nullable(),
  consecutiveFailures: z.number(),
  lastError: z.string().nullable(),
  websubActive: z.boolean(),
  subscribedAt: z.date(),
  lastFetchEntryCount: z.number().nullable(),
  lastFetchSizeBytes: z.number().nullable(),
  totalEntryCount: z.number(),
  entriesPerWeek: z.number().nullable(),
});

// ============================================================================
// Router
// ============================================================================

export const feedStatsRouter = createTRPCRouter({
  /**
   * List feed statistics for all subscribed feeds.
   *
   * Returns all feeds the user is actively subscribed to with their
   * fetch status, timing information, and error states.
   *
   * Ordered by title alphabetically, with cursor-based pagination.
   */
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/feed-stats",
        tags: ["Feed Stats"],
        summary: "List feed statistics",
      },
    })
    .input(
      z
        .object({
          cursor: z.string().optional(),
          limit: z.number().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
        })
        .optional()
    )
    .output(
      z.object({
        items: z.array(feedStatsOutputSchema),
        nextCursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const limit = input?.limit ?? DEFAULT_LIMIT;
      const cursor = input?.cursor;

      // Build WHERE conditions
      const conditions = [
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        eq(feeds.type, "web"),
      ];

      // Cursor-based pagination matching ORDER BY (resolved_title ASC, id DESC).
      // We need composite logic since the primary sort (title) differs from the cursor column (id).
      if (cursor) {
        conditions.push(
          sql`(
            COALESCE(${subscriptions.customTitle}, ${feeds.title}, ${feeds.url}) > (
              SELECT COALESCE(s2.custom_title, f2.title, f2.url)
              FROM subscriptions s2
              JOIN feeds f2 ON f2.id = s2.feed_id
              WHERE s2.id = ${cursor}
            )
            OR (
              COALESCE(${subscriptions.customTitle}, ${feeds.title}, ${feeds.url}) = (
                SELECT COALESCE(s2.custom_title, f2.title, f2.url)
                FROM subscriptions s2
                JOIN feeds f2 ON f2.id = s2.feed_id
                WHERE s2.id = ${cursor}
              )
              AND ${subscriptions.id} < ${cursor}
            )
          )`
        );
      }

      // Per-feed entry stats computed in a single pass via LEFT JOIN LATERAL.
      // Using correlated scalar subqueries here caused Postgres to re-execute the
      // entries scan for every reference (up to 4x per feed row); the lateral
      // aggregates COUNT and MIN(fetched_at) once per feed instead (#830).
      const entryStatsSq = ctx.db
        .select({
          totalCount: count().as("total_count"),
          oldestFetchedAt: sql<Date | null>`MIN(${entries.fetchedAt})`.as("oldest_fetched_at"),
        })
        .from(entries)
        .where(eq(entries.feedId, feeds.id))
        .as("entry_stats");

      // Entries per week: count / weeks since oldest entry
      const entriesPerWeekExpr = sql<number | null>`
        CASE
          WHEN ${entryStatsSq.totalCount} = 0 THEN NULL
          WHEN ${entryStatsSq.oldestFetchedAt} IS NULL THEN NULL
          WHEN EXTRACT(EPOCH FROM (NOW() - ${entryStatsSq.oldestFetchedAt})) < 604800 THEN NULL
          ELSE ${entryStatsSq.totalCount}::float / (EXTRACT(EPOCH FROM (NOW() - ${entryStatsSq.oldestFetchedAt})) / 604800.0)
        END
      `;

      // Get all web feeds the user is subscribed to with their stats
      const feedStats = await ctx.db
        .select({
          feedId: feeds.id,
          subscriptionId: subscriptions.id,
          title: feeds.title,
          customTitle: subscriptions.customTitle,
          url: feeds.url,
          siteUrl: feeds.siteUrl,
          lastFetchedAt: feeds.lastFetchedAt,
          lastEntriesUpdatedAt: feeds.lastEntriesUpdatedAt,
          nextFetchAt: feeds.nextFetchAt,
          consecutiveFailures: feeds.consecutiveFailures,
          lastError: feeds.lastError,
          websubActive: feeds.websubActive,
          subscribedAt: subscriptions.subscribedAt,
          lastFetchEntryCount: feeds.lastFetchEntryCount,
          lastFetchSizeBytes: feeds.lastFetchSizeBytes,
          totalEntryCount: entryStatsSq.totalCount,
          entriesPerWeek: entriesPerWeekExpr.as("entries_per_week"),
        })
        .from(feeds)
        .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
        .leftJoinLateral(entryStatsSq, sql`true`)
        .where(and(...conditions))
        .orderBy(
          sql`COALESCE(${subscriptions.customTitle}, ${feeds.title}, ${feeds.url}) ASC`,
          sql`${subscriptions.id} DESC`
        )
        .limit(limit + 1);

      // Check if there are more results
      let nextCursor: string | undefined;
      if (feedStats.length > limit) {
        const nextItem = feedStats.pop()!;
        nextCursor = nextItem.subscriptionId;
      }

      return {
        items: feedStats.map((feed) => ({
          feedId: feed.feedId,
          subscriptionId: feed.subscriptionId,
          title: feed.title,
          customTitle: feed.customTitle,
          url: feed.url,
          siteUrl: feed.siteUrl,
          lastFetchedAt: feed.lastFetchedAt,
          lastEntriesUpdatedAt: feed.lastEntriesUpdatedAt,
          nextFetchAt: feed.nextFetchAt,
          consecutiveFailures: feed.consecutiveFailures,
          lastError: feed.lastError,
          websubActive: feed.websubActive,
          subscribedAt: feed.subscribedAt,
          lastFetchEntryCount: feed.lastFetchEntryCount,
          lastFetchSizeBytes: feed.lastFetchSizeBytes,
          totalEntryCount: Number(feed.totalEntryCount),
          entriesPerWeek: feed.entriesPerWeek != null ? Number(feed.entriesPerWeek) : null,
        })),
        nextCursor,
      };
    }),
});
