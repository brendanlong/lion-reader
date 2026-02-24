/**
 * Broken Feeds Router
 *
 * Provides endpoints for viewing feeds with fetch errors and retrying failed fetches.
 * A feed is considered "broken" when it has consecutive fetch failures > 0.
 */

import { z } from "zod";
import { eq, and, gt, isNull, sql, count } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { feeds, subscriptions, jobs } from "@/server/db/schema";

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Broken feed output schema - what we return for a broken feed.
 */
const brokenFeedOutputSchema = z.object({
  feedId: z.string(),
  subscriptionId: z.string().nullable(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  consecutiveFailures: z.number(),
  lastError: z.string().nullable(),
  lastFetchedAt: z.date().nullable(),
  nextFetchAt: z.date().nullable(),
  subscriberCount: z.number(),
});

// ============================================================================
// Router
// ============================================================================

export const brokenFeedsRouter = createTRPCRouter({
  /**
   * List all broken feeds.
   *
   * Returns web feeds that have at least one consecutive fetch failure.
   * Optionally filters to only feeds with active subscribers (default: true).
   * Includes the current user's subscription ID if they are subscribed.
   *
   * Ordered by failure count (highest first), then by last fetch time.
   */
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/broken-feeds",
        tags: ["Broken Feeds"],
        summary: "List broken feeds",
      },
    })
    .input(
      z
        .object({
          hasSubscribers: z.boolean().default(true),
        })
        .optional()
    )
    .output(
      z.object({
        items: z.array(brokenFeedOutputSchema),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const hasSubscribers = input?.hasSubscribers ?? true;

      // Subscriber count subquery
      const subscriberCountSq = ctx.db
        .select({ count: count().as("subscriber_count") })
        .from(subscriptions)
        .where(and(eq(subscriptions.feedId, feeds.id), isNull(subscriptions.unsubscribedAt)));

      // Current user's subscription ID subquery
      const userSubscriptionSq = sql<string | null>`(
        SELECT ${subscriptions.id} FROM ${subscriptions}
        WHERE ${subscriptions.feedId} = ${feeds.id}
          AND ${subscriptions.userId} = ${userId}
          AND ${subscriptions.unsubscribedAt} IS NULL
        LIMIT 1
      )`;

      const conditions = [eq(feeds.type, "web"), gt(feeds.consecutiveFailures, 0)];

      if (hasSubscribers) {
        conditions.push(sql`(${subscriberCountSq}) > 0`);
      }

      const brokenFeeds = await ctx.db
        .select({
          feedId: feeds.id,
          subscriptionId: userSubscriptionSq.as("user_subscription_id"),
          title: feeds.title,
          url: feeds.url,
          consecutiveFailures: feeds.consecutiveFailures,
          lastError: feeds.lastError,
          lastFetchedAt: feeds.lastFetchedAt,
          nextFetchAt: feeds.nextFetchAt,
          subscriberCount: sql<number>`(${subscriberCountSq})`.as("subscriber_count"),
        })
        .from(feeds)
        .where(and(...conditions))
        .orderBy(
          sql`${feeds.consecutiveFailures} DESC`,
          sql`${feeds.lastFetchedAt} DESC NULLS LAST`
        );

      return {
        items: brokenFeeds.map((feed) => ({
          feedId: feed.feedId,
          subscriptionId: feed.subscriptionId,
          title: feed.title,
          url: feed.url,
          consecutiveFailures: feed.consecutiveFailures,
          lastError: feed.lastError,
          lastFetchedAt: feed.lastFetchedAt,
          nextFetchAt: feed.nextFetchAt,
          subscriberCount: Number(feed.subscriberCount),
        })),
      };
    }),

  /**
   * Retry fetching a broken feed.
   *
   * Resets the failure counter and schedules an immediate fetch.
   *
   * @param feedId - The feed ID to retry
   * @returns Success status
   */
  retryFetch: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/broken-feeds/{feedId}/retry",
        tags: ["Broken Feeds"],
        summary: "Retry fetching a broken feed",
      },
    })
    .input(
      z.object({
        feedId: z.string().uuid("Invalid feed ID"),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date();

      // Reset the feed's failure counter and schedule immediate fetch
      await ctx.db
        .update(feeds)
        .set({
          consecutiveFailures: 0,
          lastError: null,
          nextFetchAt: now,
          updatedAt: now,
        })
        .where(eq(feeds.id, input.feedId));

      // Also update the job to run immediately
      await ctx.db
        .update(jobs)
        .set({
          consecutiveFailures: 0,
          lastError: null,
          nextRunAt: now,
          updatedAt: now,
        })
        .where(sql`${jobs.payload}->>'feedId' = ${input.feedId} AND ${jobs.type} = 'fetch_feed'`);

      return { success: true };
    }),
});
