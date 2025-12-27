/**
 * Subscriptions Router
 *
 * Handles feed subscriptions: list, create, update, delete.
 * Implements subscription management with soft delete pattern.
 */

import { z } from "zod";
import { eq, and, isNull, sql } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure, expensiveProtectedProcedure } from "../trpc";
import { errors } from "../errors";
import { feeds, subscriptions, entries, userEntryStates } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { parseFeed, discoverFeeds, detectFeedType } from "@/server/feed";
import { createInitialFetchJob } from "@/server/jobs/handlers";
import type { FeedType } from "@/server/feed";

// ============================================================================
// Constants
// ============================================================================

/**
 * User-Agent header sent when fetching feeds.
 */
const USER_AGENT = "LionReader/1.0 (+https://lionreader.com/bot)";

/**
 * Timeout for feed fetch requests (10 seconds).
 */
const FETCH_TIMEOUT_MS = 10000;

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * URL validation schema for feed subscription.
 */
const urlSchema = z
  .string()
  .min(1, "URL is required")
  .max(2048, "URL must be less than 2048 characters")
  .url("Invalid URL format")
  .refine((url) => url.startsWith("http://") || url.startsWith("https://"), {
    message: "URL must use http or https protocol",
  });

/**
 * UUID validation schema for subscription IDs.
 */
const uuidSchema = z.string().uuid("Invalid subscription ID");

/**
 * Custom title validation schema.
 */
const customTitleSchema = z
  .string()
  .max(255, "Custom title must be less than 255 characters")
  .nullable();

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Feed output schema - what we return for a feed.
 */
const feedOutputSchema = z.object({
  id: z.string(),
  type: z.enum(["rss", "atom", "json"]),
  url: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  siteUrl: z.string().nullable(),
});

/**
 * Subscription output schema - what we return for a subscription.
 */
const subscriptionOutputSchema = z.object({
  id: z.string(),
  feedId: z.string(),
  customTitle: z.string().nullable(),
  subscribedAt: z.date(),
  unreadCount: z.number(),
});

/**
 * Subscription with feed output schema.
 */
const subscriptionWithFeedOutputSchema = z.object({
  subscription: subscriptionOutputSchema,
  feed: feedOutputSchema,
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Fetches content from a URL with proper error handling.
 *
 * @param url - The URL to fetch
 * @returns The response with text content
 */
async function fetchUrl(url: string): Promise<{ text: string; contentType: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      throw errors.feedFetchError(url, `HTTP ${response.status}`);
    }

    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";

    return { text, contentType };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw errors.feedFetchError(url, "Request timed out");
    }
    if (error instanceof Error && "code" in error) {
      // This is already a TRPCError
      throw error;
    }
    throw errors.feedFetchError(url, error instanceof Error ? error.message : "Unknown error");
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Determines if content is HTML (for feed discovery) or a feed.
 *
 * @param contentType - The content type header
 * @param content - The content body
 * @returns true if the content is HTML
 */
function isHtmlContent(contentType: string, content: string): boolean {
  // Check content type header
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    return true;
  }

  // Fallback: check content itself
  const trimmed = content.trim().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}

// ============================================================================
// Router
// ============================================================================

export const subscriptionsRouter = createTRPCRouter({
  /**
   * Subscribe to a feed by URL.
   *
   * This procedure:
   * 1. Fetches the URL content
   * 2. If HTML, discovers feeds and uses the first one
   * 3. Parses the feed to get metadata
   * 4. Creates or finds the existing feed record
   * 5. Creates the subscription (or reactivates if previously unsubscribed)
   *
   * @param url - The feed URL (or HTML page with feed discovery)
   * @returns The subscription and feed
   *
   * Note: This endpoint uses stricter rate limiting (10 burst, 1/sec)
   * since it involves external HTTP requests.
   */
  create: expensiveProtectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/subscriptions",
        tags: ["Subscriptions"],
        summary: "Subscribe to a feed",
      },
    })
    .input(
      z.object({
        url: urlSchema,
      })
    )
    .output(subscriptionWithFeedOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      let feedUrl = input.url;

      // Step 1: Fetch the URL
      const { text: content, contentType } = await fetchUrl(feedUrl);

      // Step 2: If HTML, try to discover feeds
      let feedContent: string;
      if (isHtmlContent(contentType, content)) {
        const discoveredFeeds = discoverFeeds(content, feedUrl);

        if (discoveredFeeds.length === 0) {
          throw errors.validation("No feeds found at this URL");
        }

        // Use the first discovered feed
        feedUrl = discoveredFeeds[0].url;

        // Fetch the actual feed
        const feedResult = await fetchUrl(feedUrl);
        feedContent = feedResult.text;
      } else {
        feedContent = content;
      }

      // Step 3: Parse the feed
      let parsedFeed;
      try {
        parsedFeed = parseFeed(feedContent);
      } catch (error) {
        throw errors.parseError(error instanceof Error ? error.message : "Invalid feed format");
      }

      // Step 4: Check if feed already exists
      const existingFeed = await ctx.db.select().from(feeds).where(eq(feeds.url, feedUrl)).limit(1);

      let feedId: string;
      let feedRecord: typeof feeds.$inferSelect;

      if (existingFeed.length > 0) {
        // Feed exists - use it
        feedId = existingFeed[0].id;
        feedRecord = existingFeed[0];
      } else {
        // Create new feed
        feedId = generateUuidv7();
        const feedType = detectFeedType(feedContent) as FeedType;
        const now = new Date();

        const newFeed = {
          id: feedId,
          type: feedType === "unknown" ? "rss" : feedType, // Default to RSS if unknown
          url: feedUrl,
          title: parsedFeed.title || null,
          description: parsedFeed.description || null,
          siteUrl: parsedFeed.siteUrl || null,
          nextFetchAt: now, // Schedule immediate fetch
          createdAt: now,
          updatedAt: now,
        };

        await ctx.db.insert(feeds).values(newFeed);
        feedRecord = newFeed as typeof feeds.$inferSelect;

        // Schedule initial fetch job for the new feed
        await createInitialFetchJob(feedId);
      }

      // Step 5: Check for existing subscription
      const existingSubscription = await ctx.db
        .select()
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)))
        .limit(1);

      let subscriptionId: string;
      let subscribedAt: Date;

      if (existingSubscription.length > 0) {
        const sub = existingSubscription[0];

        if (sub.unsubscribedAt === null) {
          // Already subscribed and active
          throw errors.alreadySubscribed();
        }

        // Reactivate subscription
        subscriptionId = sub.id;
        subscribedAt = new Date();

        await ctx.db
          .update(subscriptions)
          .set({
            unsubscribedAt: null,
            subscribedAt: subscribedAt,
            updatedAt: subscribedAt,
          })
          .where(eq(subscriptions.id, subscriptionId));
      } else {
        // Create new subscription
        subscriptionId = generateUuidv7();
        subscribedAt = new Date();

        await ctx.db.insert(subscriptions).values({
          id: subscriptionId,
          userId,
          feedId,
          subscribedAt,
          createdAt: subscribedAt,
          updatedAt: subscribedAt,
        });
      }

      return {
        subscription: {
          id: subscriptionId,
          feedId,
          customTitle: null,
          subscribedAt,
          unreadCount: 0, // New subscription has no unread entries yet
        },
        feed: {
          id: feedRecord.id,
          type: feedRecord.type,
          url: feedRecord.url,
          title: feedRecord.title,
          description: feedRecord.description,
          siteUrl: feedRecord.siteUrl,
        },
      };
    }),

  /**
   * List all active subscriptions for the current user.
   *
   * Returns subscriptions with their associated feed information and unread counts.
   * Subscriptions are ordered by feed title (ascending).
   */
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/v1/subscriptions",
        tags: ["Subscriptions"],
        summary: "List subscriptions",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        items: z.array(subscriptionWithFeedOutputSchema),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      // Get all active subscriptions with feed info
      const userSubscriptions = await ctx.db
        .select({
          subscription: subscriptions,
          feed: feeds,
        })
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)))
        .orderBy(feeds.title);

      // Calculate unread counts for each subscription
      // An entry is unread if:
      // 1. It was fetched after the subscription date
      // 2. It has no user_entry_state with read=true
      const items = await Promise.all(
        userSubscriptions.map(async ({ subscription, feed }) => {
          // Count entries fetched after subscription date that are not read
          const unreadResult = await ctx.db
            .select({ count: sql<number>`count(*)::int` })
            .from(entries)
            .leftJoin(
              userEntryStates,
              and(eq(userEntryStates.entryId, entries.id), eq(userEntryStates.userId, userId))
            )
            .where(
              and(
                eq(entries.feedId, feed.id),
                sql`${entries.fetchedAt} >= ${subscription.subscribedAt}`,
                sql`(${userEntryStates.read} IS NULL OR ${userEntryStates.read} = false)`
              )
            );

          const unreadCount = unreadResult[0]?.count ?? 0;

          return {
            subscription: {
              id: subscription.id,
              feedId: subscription.feedId,
              customTitle: subscription.customTitle,
              subscribedAt: subscription.subscribedAt,
              unreadCount,
            },
            feed: {
              id: feed.id,
              type: feed.type,
              url: feed.url,
              title: feed.title,
              description: feed.description,
              siteUrl: feed.siteUrl,
            },
          };
        })
      );

      return { items };
    }),

  /**
   * Get a single subscription by ID.
   *
   * Returns the subscription with its associated feed information and unread count.
   */
  get: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/v1/subscriptions/{id}",
        tags: ["Subscriptions"],
        summary: "Get subscription",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(subscriptionWithFeedOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Get the subscription with feed info
      const result = await ctx.db
        .select({
          subscription: subscriptions,
          feed: feeds,
        })
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(
          and(
            eq(subscriptions.id, input.id),
            eq(subscriptions.userId, userId),
            isNull(subscriptions.unsubscribedAt)
          )
        )
        .limit(1);

      if (result.length === 0) {
        throw errors.subscriptionNotFound();
      }

      const { subscription, feed } = result[0];

      // Calculate unread count
      const unreadResult = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(entries)
        .leftJoin(
          userEntryStates,
          and(eq(userEntryStates.entryId, entries.id), eq(userEntryStates.userId, userId))
        )
        .where(
          and(
            eq(entries.feedId, feed.id),
            sql`${entries.fetchedAt} >= ${subscription.subscribedAt}`,
            sql`(${userEntryStates.read} IS NULL OR ${userEntryStates.read} = false)`
          )
        );

      const unreadCount = unreadResult[0]?.count ?? 0;

      return {
        subscription: {
          id: subscription.id,
          feedId: subscription.feedId,
          customTitle: subscription.customTitle,
          subscribedAt: subscription.subscribedAt,
          unreadCount,
        },
        feed: {
          id: feed.id,
          type: feed.type,
          url: feed.url,
          title: feed.title,
          description: feed.description,
          siteUrl: feed.siteUrl,
        },
      };
    }),

  /**
   * Update a subscription (custom title).
   *
   * Allows users to set a custom title for their subscription.
   * Pass null to remove the custom title and use the feed's default.
   */
  update: protectedProcedure
    .meta({
      openapi: {
        method: "PATCH",
        path: "/v1/subscriptions/{id}",
        tags: ["Subscriptions"],
        summary: "Update subscription",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
        customTitle: customTitleSchema.optional(),
      })
    )
    .output(
      z.object({
        subscription: subscriptionOutputSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Verify the subscription exists and belongs to the user
      const existing = await ctx.db
        .select()
        .from(subscriptions)
        .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
        .where(
          and(
            eq(subscriptions.id, input.id),
            eq(subscriptions.userId, userId),
            isNull(subscriptions.unsubscribedAt)
          )
        )
        .limit(1);

      if (existing.length === 0) {
        throw errors.subscriptionNotFound();
      }

      const subscription = existing[0].subscriptions;
      const feed = existing[0].feeds;

      // Update the subscription
      const now = new Date();
      const updateData: { updatedAt: Date; customTitle?: string | null } = {
        updatedAt: now,
      };

      if (input.customTitle !== undefined) {
        updateData.customTitle = input.customTitle;
      }

      await ctx.db.update(subscriptions).set(updateData).where(eq(subscriptions.id, input.id));

      // Calculate unread count
      const unreadResult = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(entries)
        .leftJoin(
          userEntryStates,
          and(eq(userEntryStates.entryId, entries.id), eq(userEntryStates.userId, userId))
        )
        .where(
          and(
            eq(entries.feedId, feed.id),
            sql`${entries.fetchedAt} >= ${subscription.subscribedAt}`,
            sql`(${userEntryStates.read} IS NULL OR ${userEntryStates.read} = false)`
          )
        );

      const unreadCount = unreadResult[0]?.count ?? 0;

      return {
        subscription: {
          id: subscription.id,
          feedId: subscription.feedId,
          customTitle:
            input.customTitle !== undefined ? input.customTitle : subscription.customTitle,
          subscribedAt: subscription.subscribedAt,
          unreadCount,
        },
      };
    }),

  /**
   * Unsubscribe from a feed (soft delete).
   *
   * Sets unsubscribedAt timestamp instead of deleting the record.
   * This allows users to resubscribe later while preserving their read state.
   */
  delete: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/v1/subscriptions/{id}",
        tags: ["Subscriptions"],
        summary: "Unsubscribe from feed",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Verify the subscription exists and belongs to the user
      const existing = await ctx.db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.id, input.id),
            eq(subscriptions.userId, userId),
            isNull(subscriptions.unsubscribedAt)
          )
        )
        .limit(1);

      if (existing.length === 0) {
        throw errors.subscriptionNotFound();
      }

      // Soft delete by setting unsubscribedAt
      const now = new Date();
      await ctx.db
        .update(subscriptions)
        .set({
          unsubscribedAt: now,
          updatedAt: now,
        })
        .where(eq(subscriptions.id, input.id));

      return { success: true };
    }),
});
