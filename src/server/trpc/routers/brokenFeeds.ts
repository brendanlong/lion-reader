/**
 * Broken Feeds Router
 *
 * Provides endpoints for viewing feeds with fetch errors and retrying failed fetches.
 * A feed is considered "broken" when it has consecutive fetch failures > 0.
 */

import { z } from "zod";
import { eq, and, gt, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { request } from "@octokit/request";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { feeds, subscriptions, jobs } from "@/server/db/schema";
import { githubConfig } from "@/server/config/env";
import { USER_AGENT } from "@/server/http/user-agent";
import { logger } from "@/lib/logger";

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
// GitHub Issue Filing
// ============================================================================

const GITHUB_REPO_OWNER = "brendanlong";
const GITHUB_REPO_NAME = "lion-reader";

/**
 * Create a GitHub API request function with the issues token and custom user agent.
 */
function getGitHubRequest() {
  const token = githubConfig.issuesToken;
  if (!token) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "GitHub issue filing is not configured",
    });
  }

  return request.defaults({
    headers: {
      authorization: `token ${token}`,
      "user-agent": USER_AGENT,
    },
  });
}

/**
 * Create a GitHub issue for a broken feed.
 */
async function createGitHubIssue(params: {
  feedUrl: string;
  feedTitle: string | null;
  lastError: string | null;
  consecutiveFailures: number;
}): Promise<{ issueUrl: string }> {
  const ghRequest = getGitHubRequest();

  const title = `Broken feed: ${params.feedTitle || params.feedUrl}`;
  const body = [
    `## Broken Feed Report`,
    ``,
    `**Feed URL:** ${params.feedUrl}`,
    params.feedTitle ? `**Feed Title:** ${params.feedTitle}` : null,
    `**Consecutive Failures:** ${params.consecutiveFailures}`,
    params.lastError ? `**Last Error:**\n\`\`\`\n${params.lastError}\n\`\`\`` : null,
    ``,
    `---`,
    `*This issue was filed automatically from the Lion Reader broken feeds page.*`,
  ]
    .filter((line) => line !== null)
    .join("\n");

  try {
    const { data } = await ghRequest("POST /repos/{owner}/{repo}/issues", {
      owner: GITHUB_REPO_OWNER,
      repo: GITHUB_REPO_NAME,
      title,
      body,
      labels: ["broken-feed"],
    });

    return { issueUrl: data.html_url };
  } catch (error) {
    logger.error("Failed to create GitHub issue", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Failed to create GitHub issue. Please try again later.",
    });
  }
}

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
        canFileIssues: z.boolean(),
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
        canFileIssues: !!githubConfig.issuesToken,
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
          updatedAt: now,
        })
        .where(sql`${jobs.payload}->>'feedId' = ${input.feedId} AND ${jobs.type} = 'fetch_feed'`);

      return { success: true };
    }),

  /**
   * File a GitHub issue for a broken feed.
   *
   * Creates an issue on the Lion Reader GitHub repo with details about the
   * broken feed. Requires GITHUB_ISSUES_TOKEN to be configured.
   */
  fileIssue: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/broken-feeds/{feedId}/file-issue",
        tags: ["Broken Feeds"],
        summary: "File a GitHub issue for a broken feed",
      },
    })
    .input(
      z.object({
        feedId: z.string().uuid("Invalid feed ID"),
      })
    )
    .output(z.object({ issueUrl: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Verify the user is subscribed to this feed and get feed details
      const result = await ctx.db
        .select({
          feedId: feeds.id,
          title: feeds.title,
          url: feeds.url,
          consecutiveFailures: feeds.consecutiveFailures,
          lastError: feeds.lastError,
        })
        .from(feeds)
        .innerJoin(subscriptions, eq(subscriptions.feedId, feeds.id))
        .where(
          and(
            eq(subscriptions.userId, userId),
            eq(feeds.id, input.feedId),
            isNull(subscriptions.unsubscribedAt),
            gt(feeds.consecutiveFailures, 0)
          )
        )
        .limit(1);

      if (result.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Feed not found, not subscribed, or not broken",
        });
      }

      const feed = result[0];

      if (!feed.url) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Feed has no URL",
        });
      }

      return createGitHubIssue({
        feedUrl: feed.url,
        feedTitle: feed.title,
        lastError: feed.lastError,
        consecutiveFailures: feed.consecutiveFailures,
      });
    }),
});
