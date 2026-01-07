/**
 * Broken Feeds Router
 *
 * Provides endpoints for viewing feeds with fetch errors and retrying failed fetches.
 * A feed is considered "broken" when it has consecutive fetch failures > 0.
 */

import { z } from "zod";
import { eq, and, gt, isNull, sql } from "drizzle-orm";

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
  subscriptionId: z.string(),
  title: z.string().nullable(),
  url: z.string().nullable(),
  consecutiveFailures: z.number(),
  lastError: z.string().nullable(),
  lastFetchedAt: z.date().nullable(),
  nextFetchAt: z.date().nullable(),
});

// ============================================================================
// Router
// ============================================================================

export const brokenFeedsRouter = createTRPCRouter({
  /**
   * List all broken feeds for the current user.
   *
   * Returns feeds that:
   * - The user is actively subscribed to (not unsubscribed)
   * - Have at least one consecutive fetch failure
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
    .input(z.object({}).optional())
    .output(
      z.object({
        items: z.array(brokenFeedOutputSchema),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      // Get all broken feeds the user is subscribed to
      const brokenFeeds = await ctx.db
        .select({
          feedId: feeds.id,
          subscriptionId: subscriptions.id,
          title: feeds.title,
          url: feeds.url,
          consecutiveFailures: feeds.consecutiveFailures,
          lastError: feeds.lastError,
          lastFetchedAt: feeds.lastFetchedAt,
          nextFetchAt: feeds.nextFetchAt,
        })
        .from(feeds)
        .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
        .where(
          and(
            eq(subscriptions.userId, userId),
            isNull(subscriptions.unsubscribedAt),
            gt(feeds.consecutiveFailures, 0)
          )
        )
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
        })),
      };
    }),

  /**
   * Retry fetching a broken feed.
   *
   * Resets the failure counter and schedules an immediate fetch.
   * Only works for feeds the user is subscribed to.
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
      const userId = ctx.session.user.id;

      // Verify the user is subscribed to this feed
      const subscription = await ctx.db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.userId, userId),
            eq(subscriptions.feedId, input.feedId),
            isNull(subscriptions.unsubscribedAt)
          )
        )
        .limit(1);

      if (subscription.length === 0) {
        throw new Error("Feed not found or not subscribed");
      }

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
          enabled: true,
          updatedAt: now,
        })
        .where(sql`${jobs.payload}->>'feedId' = ${input.feedId} AND ${jobs.type} = 'fetch_feed'`);

      return { success: true };
    }),
});
