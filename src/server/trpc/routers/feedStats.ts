/**
 * Feed Stats Router
 *
 * Provides endpoints for viewing feed fetch statistics for subscribed feeds.
 * Shows last fetch times, next scheduled fetches, error states, and WebSub status.
 */

import { z } from "zod";
import { eq, and, isNull, sql } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { feeds, subscriptions } from "@/server/db/schema";

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
   * Ordered by title alphabetically.
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
    .input(z.object({}).optional())
    .output(
      z.object({
        items: z.array(feedStatsOutputSchema),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

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
        })
        .from(feeds)
        .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
        .where(
          and(
            eq(subscriptions.userId, userId),
            isNull(subscriptions.unsubscribedAt),
            eq(feeds.type, "web")
          )
        )
        .orderBy(sql`COALESCE(${subscriptions.customTitle}, ${feeds.title}, ${feeds.url}) ASC`);

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
        })),
      };
    }),
});
