/**
 * Subscriptions Router
 *
 * Handles feed subscriptions: list, create, update, delete, import, export.
 * Implements subscription management with soft delete pattern.
 */

import { z } from "zod";

import {
  createTRPCRouter,
  confirmedProtectedProcedure as protectedProcedure,
  expensiveConfirmedProtectedProcedure as expensiveProtectedProcedure,
  scopedProtectedProcedure,
} from "../trpc";
import { READER_SCOPES } from "@/server/auth/api-token";
import { errors } from "@/server/errors";
import { feedUrlSchema, uuidSchema } from "../validation";
import { OpmlParseError } from "@/server/feed/opml";
import { logger } from "@/lib/logger";
import * as subscribeService from "@/server/services/subscribe";
import * as subscriptionUpdatesService from "@/server/services/subscription-updates";
import * as subscriptionsService from "@/server/services/subscriptions";
import { importOpml } from "@/server/services/imports";
import { countsAsOfSchema, unreadCountsSchema } from "@/lib/events/schemas";
import { SUBSCRIPTION_TYPES } from "@/lib/entry-types";

// Endpoints exposed via the MCP tool surface; the native app uses them too.
const readerProcedure = scopedProtectedProcedure(READER_SCOPES);

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Custom title validation schema. Trimmed, like a collection name on create,
 * so a rename can't make a near-duplicate ("News " next to "News").
 */
const customTitleSchema = z
  .string()
  .trim()
  .max(
    subscriptionUpdatesService.CUSTOM_TITLE_MAX_LENGTH,
    `Custom title must be at most ${subscriptionUpdatesService.CUSTOM_TITLE_MAX_LENGTH} characters`
  )
  .nullable();

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Tag output schema for subscriptions - lightweight tag info.
 */
const tagOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});

/**
 * Flat subscription output schema - subscription with feed metadata merged.
 * Uses subscription.id as the primary key, hiding internal feedId from clients.
 */
export const subscriptionOutputSchema = z.object({
  id: z.string(), // subscription ID (primary key)
  type: z.enum(SUBSCRIPTION_TYPES),
  url: z.string().nullable(),
  title: z.string().nullable(), // resolved title (custom or original)
  originalTitle: z.string().nullable(), // feed's original title for rename UI
  description: z.string().nullable(),
  siteUrl: z.string().nullable(),
  subscribedAt: z.date(),
  unreadCount: z.number(),
  unreadCountAsOf: countsAsOfSchema,
  tags: z.array(tagOutputSchema),
  fetchFullContent: z.boolean(), // whether to fetch full article content from URL
});

/**
 * Create response: a subscription plus the absolute unread counts for the
 * lists it affected, so the client sets counts directly instead of estimating.
 */
const createSubscriptionOutputSchema = subscriptionOutputSchema.extend({
  counts: unreadCountsSchema.optional(),
});

// ============================================================================
// Subscription Helpers
// ============================================================================

/**
 * Format a CreateSubscriptionResult into the API response shape.
 */
function formatSubscriptionResponse(
  result: subscribeService.CreateSubscriptionResult
): z.infer<typeof createSubscriptionOutputSchema> {
  return {
    id: result.subscriptionId,
    type: result.feed.type,
    url: result.feed.url,
    title: result.customTitle ?? result.feed.title,
    originalTitle: result.feed.title,
    description: result.feed.description,
    siteUrl: result.feed.siteUrl,
    subscribedAt: result.subscribedAt,
    unreadCount: result.unreadCount,
    unreadCountAsOf: result.unreadCountAsOf,
    tags: [],
    fetchFullContent: result.fetchFullContent,
    counts: result.counts,
  };
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
        path: "/subscriptions",
        tags: ["Subscriptions"],
        summary: "Subscribe to a feed",
      },
    })
    .input(
      z.object({
        url: feedUrlSchema,
      })
    )
    .output(createSubscriptionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await subscribeService.subscribeToUrl(ctx.db, ctx.session.user.id, input.url);
      return formatSubscriptionResponse(result);
    }),

  /**
   * List all active subscriptions for the current user.
   *
   * Supports optional filtering and pagination:
   * - query: Case-insensitive title search (substring matching)
   * - tagId: Filter by tag
   * - uncategorized: Only show subscriptions with no tags
   * - unreadOnly: Only show feeds with unread items
   * - cursor/limit: Cursor-based pagination (MAX_SUBSCRIPTIONS_PAGE_SIZE per page)
   *
   * Returns subscriptions with their associated feed information and unread counts.
   */
  list: readerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/subscriptions",
        tags: ["Subscriptions"],
        summary: "List subscriptions",
      },
    })
    .input(
      z
        .object({
          query: z.string().optional(),
          tagId: z.string().uuid().optional(),
          uncategorized: z.boolean().optional(),
          unreadOnly: z.boolean().optional(),
          type: subscriptionOutputSchema.shape.type.optional(),
          cursor: z.string().optional(),
          limit: z.number().min(1).max(subscriptionsService.MAX_SUBSCRIPTIONS_PAGE_SIZE).optional(),
        })
        .optional()
    )
    .output(
      z.object({
        items: z.array(subscriptionOutputSchema),
        nextCursor: z.string().optional(),
        // The user's saved subscription (#1846), which `items` never lists:
        // entries' `subscriptionIds` name it for saved articles. Null until
        // the first save creates it.
        savedSubscriptionId: z.string().nullable(),
      })
    )
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const [result, savedSubscriptionId] = await Promise.all([
        subscriptionsService.listSubscriptions(ctx.db, { userId, ...input }),
        subscriptionsService.getSavedSubscriptionId(ctx.db, userId),
      ]);
      return { items: result.subscriptions, nextCursor: result.nextCursor, savedSubscriptionId };
    }),

  /**
   * Get a single subscription by ID.
   *
   * Returns the subscription with its associated feed information and unread count.
   */
  get: readerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/subscriptions/{id}",
        tags: ["Subscriptions"],
        summary: "Get subscription",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(subscriptionOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      return subscriptionsService.getSubscription(ctx.db, userId, input.id);
    }),

  /**
   * Update a subscription.
   *
   * Allows users to update subscription settings:
   * - customTitle: Set a custom title (null to use feed's default). For a
   *   collection it's the name: required, and unique among the user's active
   *   collections ignoring case (COLLECTION_NAME_TAKEN otherwise).
   * - fetchFullContent: Whether to fetch full article content from URL
   */
  update: protectedProcedure
    .meta({
      openapi: {
        method: "PATCH",
        path: "/subscriptions/{id}",
        tags: ["Subscriptions"],
        summary: "Update subscription",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
        customTitle: customTitleSchema.optional(),
        fetchFullContent: z.boolean().optional(),
      })
    )
    .output(subscriptionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const { id, ...params } = input;
      return subscriptionUpdatesService.updateSubscription(ctx.db, ctx.session.user.id, id, params);
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
        path: "/subscriptions/{id}",
        tags: ["Subscriptions"],
        summary: "Unsubscribe from feed",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(z.object({ success: z.boolean(), counts: unreadCountsSchema.optional() }))
    .mutation(async ({ ctx, input }) => {
      const result = await subscriptionUpdatesService.unsubscribe(
        ctx.db,
        ctx.session.user.id,
        input.id
      );
      if (!result) {
        throw errors.subscriptionNotFound();
      }
      return { success: true, counts: result.counts };
    }),

  /**
   * Import feeds from OPML content.
   *
   * This procedure:
   * 1. Parses the OPML XML content
   * 2. For each feed, creates or finds the existing feed record
   * 3. Creates subscriptions (skips already subscribed feeds)
   * 4. Returns import results with counts and errors
   *
   * @param opml - The OPML XML content as a string
   * @returns Import results with imported, skipped, and error counts
   */
  import: expensiveProtectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/subscriptions/import",
        tags: ["Subscriptions"],
        summary: "Import feeds from OPML",
      },
    })
    .input(
      z.object({
        opml: z
          .string()
          .min(1, "OPML content is required")
          .max(5 * 1024 * 1024, "OPML file too large (max 5MB)"),
      })
    )
    .output(
      z.object({
        importId: z.string(),
        totalFeeds: z.number(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await importOpml(ctx.db, ctx.session.user.id, input.opml);
      } catch (error) {
        if (error instanceof OpmlParseError) {
          throw errors.validation(`Failed to parse OPML: ${error.message}`);
        }
        throw error;
      }
    }),

  /**
   * Export subscriptions as OPML.
   *
   * Generates an OPML XML file containing all active subscriptions
   * for the current user. Feeds are listed at the top level and
   * re-listed inside their tag folders.
   *
   * @returns OPML XML content
   */
  export: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/subscriptions/export",
        tags: ["Subscriptions"],
        summary: "Export subscriptions as OPML",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        opml: z.string(),
        feedCount: z.number(),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      const { opml, feedCount } = await subscriptionsService.exportSubscriptionsOpml(
        ctx.db,
        userId
      );

      logger.info("OPML export completed", {
        userId,
        feedCount,
      });

      return { opml, feedCount };
    }),

  /**
   * Set tags for a subscription (replace all).
   *
   * This replaces all existing tags on the subscription with the provided tag IDs.
   * All tag IDs must belong to the current user.
   *
   * @param id - The subscription ID
   * @param tagIds - Array of tag IDs to set
   * @returns The updated subscription
   */
  setTags: readerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/subscriptions/{id}/tags",
        tags: ["Subscriptions"],
        summary: "Set subscription tags",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
        tagIds: z.array(z.string().uuid("Invalid tag ID")),
      })
    )
    .output(subscriptionOutputSchema)
    .mutation(async ({ ctx, input }) => {
      await subscriptionUpdatesService.setSubscriptionTags(
        ctx.db,
        ctx.session.user.id,
        input.id,
        input.tagIds
      );
      return subscriptionsService.getSubscription(ctx.db, ctx.session.user.id, input.id);
    }),
});

// Export helper for use in background job handlers
