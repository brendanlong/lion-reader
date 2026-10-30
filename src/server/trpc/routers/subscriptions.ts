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
import {
  booleanQueryParam,
  feedUrlSchema,
  subscriptionListInputSchema,
  subscriptionTagIdsSchema,
  uuidSchema,
} from "../validation";
import { OpmlParseError } from "@/server/feed/opml";
import { logger } from "@/lib/logger";
import * as subscribeService from "@/server/services/subscribe";
import * as subscriptionUpdatesService from "@/server/services/subscription-updates";
import * as subscriptionsService from "@/server/services/subscriptions";
import { importOpml, MAX_OPML_BYTES } from "@/server/services/imports";
import { unreadCountsSchema } from "@/lib/events/schemas";

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
 * Create response: a subscription plus the absolute unread counts for the
 * lists it affected, so the client sets counts directly instead of estimating.
 */
const createSubscriptionOutputSchema = subscriptionsService.subscriptionSchema.extend({
  counts: unreadCountsSchema.optional(),
});

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
      const { subscription, counts } = await subscribeService.subscribeToUrl(
        ctx.db,
        ctx.session.user.id,
        input.url
      );
      return { ...subscription, counts };
    }),

  /**
   * List all active subscriptions for the current user.
   *
   * Supports optional filtering and pagination:
   * - query: Case-insensitive title search (substring matching)
   * - tagId: Filter by tag
   * - uncategorized: Only show subscriptions with no tags
   * - unreadOnly: Only show feeds with unread items
   * - type: Only show subscriptions of this type
   * - cursor/limit: Cursor-based pagination (MAX_SUBSCRIPTIONS_PAGE_SIZE per page)
   *
   * Returns subscriptions with their associated feed information and unread counts.
   * The user's saved subscription (#1846, type `saved`, created by their first
   * save) is listed too: its members are the Saved list, and it's in no tag or
   * Uncategorized.
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
      subscriptionListInputSchema()
        .extend({
          uncategorized: booleanQueryParam,
          unreadOnly: booleanQueryParam,
          type: subscriptionsService.subscriptionSchema.shape.type.optional(),
        })
        .optional()
    )
    .output(
      z.object({
        items: z.array(subscriptionsService.subscriptionSchema),
        nextCursor: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const result = await subscriptionsService.listSubscriptions(ctx.db, {
        userId: ctx.session.user.id,
        ...input,
      });
      return { items: result.subscriptions, nextCursor: result.nextCursor };
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
    .output(subscriptionsService.subscriptionSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      return subscriptionsService.getSubscription(ctx.db, userId, input.id);
    }),

  /**
   * Get an email subscription's sender address (null for other subscription
   * types), so unsubscribing can offer to block it.
   */
  getEmailSender: protectedProcedure
    .input(z.object({ id: uuidSchema }))
    .output(z.object({ emailSender: z.string().nullable() }))
    .query(async ({ ctx, input }) => ({
      emailSender: await subscriptionsService.getEmailSender(ctx.db, ctx.session.user.id, input.id),
    })),

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
    .output(subscriptionsService.subscriptionSchema)
    .mutation(async ({ ctx, input }) => {
      const { id, ...params } = input;
      return subscriptionUpdatesService.updateSubscription(ctx.db, ctx.session.user.id, id, params);
    }),

  /**
   * Unsubscribe from a feed (soft delete).
   *
   * Sets unsubscribedAt timestamp instead of deleting the record.
   * This allows users to resubscribe later while preserving their read state.
   * For an email subscription, `blockSender` also rejects the sender's future
   * emails; without it, the sender's next email resubscribes. For a
   * collection, `deleteSavedArticles` also deletes its saved articles that are
   * in no other collection.
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
        blockSender: booleanQueryParam,
        deleteSavedArticles: booleanQueryParam,
      })
    )
    .output(z.object({ success: z.boolean(), counts: unreadCountsSchema.optional() }))
    .mutation(async ({ ctx, input }) => {
      const result = await subscriptionUpdatesService.unsubscribe(
        ctx.db,
        ctx.session.user.id,
        input.id,
        { blockSender: input.blockSender, deleteSavedArticles: input.deleteSavedArticles }
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
          .max(MAX_OPML_BYTES, "OPML file too large (max 5MB)"),
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
        tagIds: subscriptionTagIdsSchema,
      })
    )
    .output(subscriptionsService.subscriptionSchema)
    .mutation(async ({ ctx, input }) =>
      subscriptionUpdatesService.setSubscriptionTags(
        ctx.db,
        ctx.session.user.id,
        input.id,
        input.tagIds
      )
    ),
});

// Export helper for use in background job handlers
