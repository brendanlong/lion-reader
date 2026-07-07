/**
 * Entries Router
 *
 * Handles entry listing and actions: list, get, mark read, star.
 *
 * Visibility rules:
 * - Users only see entries with a corresponding user_entries row for their user_id
 * - Additionally, entries must be from an active subscription (not unsubscribed)
 * - Exception: Starred entries are always visible, even after unsubscribing
 */

import { z } from "zod";
import { eq, and } from "drizzle-orm";

import {
  createTRPCRouter,
  confirmedProtectedProcedure as protectedProcedure,
  scopedProtectedProcedure,
} from "../trpc";
import { API_TOKEN_SCOPES } from "@/server/auth/api-token";
import { errors } from "../errors";
import { uuidSchema } from "../validation";
import { tags } from "@/server/db/schema";
import * as fullContentService from "@/server/services/full-content";
import * as entriesService from "@/server/services/entries";
import { getSubscriptionFeedIds } from "@/server/services/entry-filters";

// Endpoints exposed via the MCP tool surface; accessible to tokens with the `mcp` scope.
const mcpProcedure = scopedProtectedProcedure(API_TOKEN_SCOPES.MCP);

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of entries that can be requested per page.
 */
const MAX_LIMIT = 100;

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * Cursor validation schema (base64-encoded entry ID).
 */
const cursorSchema = z.string().optional();

/**
 * Limit validation schema.
 */
const limitSchema = z.number().int().min(1).max(MAX_LIMIT).optional();

/**
 * Sort order validation schema.
 */
const sortOrderSchema = z.enum(["newest", "oldest"]).optional();

/**
 * Sort by validation schema for choosing which timestamp to sort entries by.
 */
const sortBySchema = z.enum(["published", "readChanged"]).optional();

/**
 * Feed type validation schema for filtering entries by type.
 */
const feedTypeSchema = z.enum(["web", "email", "saved"]);

/**
 * Boolean query parameter schema that handles string coercion.
 * Query parameters come as strings from HTTP requests, so we need to
 * handle both boolean and string inputs ("true"/"false").
 */
const booleanQueryParam = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .optional()
  .transform((val) => {
    if (val === "true") return true;
    if (val === "false") return false;
    return val;
  });

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Lightweight entry output schema for list view (no full content).
 */
const entryListItemSchema = z.object({
  id: z.string(),
  subscriptionId: z.string().nullable(), // null for orphaned starred entries
  feedId: z.string(), // Internal use only - kept for cache invalidation
  type: feedTypeSchema,
  url: z.string().nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  summary: z.string().nullable(),
  publishedAt: z.date().nullable(),
  fetchedAt: z.date(),
  read: z.boolean(),
  starred: z.boolean(),
  updatedAt: z.date(), // Max of entry and user state updated_at - for cache freshness
  feedTitle: z.string().nullable(),
  siteName: z.string().nullable(),
});

/**
 * Full entry output schema for single entry view (includes content).
 */
const entryFullSchema = z.object({
  id: z.string(),
  subscriptionId: z.string().nullable(), // null for orphaned starred entries
  feedId: z.string(), // Internal use only - kept for cache invalidation
  type: feedTypeSchema,
  url: z.string().nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  contentOriginal: z.string().nullable(),
  contentCleaned: z.string().nullable(),
  summary: z.string().nullable(),
  publishedAt: z.date().nullable(),
  fetchedAt: z.date(),
  read: z.boolean(),
  starred: z.boolean(),
  updatedAt: z.date(), // Max of entry and user state updated_at - for cache freshness
  feedTitle: z.string().nullable(),
  feedUrl: z.string().nullable(),
  siteName: z.string().nullable(),
  // Unsubscribe link from email HTML (for email entries)
  unsubscribeUrl: z.string().nullable(),
  // Full content fields
  fullContentOriginal: z.string().nullable(),
  fullContentCleaned: z.string().nullable(),
  fullContentFetchedAt: z.date().nullable(),
  fullContentError: z.string().nullable(),
  // Subscription field - included to avoid separate subscriptions.get query
  fetchFullContent: z.boolean(), // subscription setting for auto-fetching full content
});

/**
 * Paginated entries list output schema.
 */
const entriesListOutputSchema = z.object({
  items: z.array(entryListItemSchema),
  nextCursor: z.string().optional(),
});

/**
 * Schema for entries returned from mutation operations.
 * Contains minimal fields needed for optimistic updates plus updatedAt for cache freshness.
 */
const entryMutationResultSchema = z.object({
  id: z.string(),
  read: z.boolean(),
  starred: z.boolean(),
  updatedAt: z.date(), // For comparing with cached data to determine winner
});

/**
 * Schema for unread counts returned from single-entry mutations.
 * Contains absolute counts for all lists the entry belongs to.
 */
const unreadCountsSchema = z.object({
  // Always present
  all: z.object({ unread: z.number() }),
  starred: z.object({ unread: z.number() }),

  // Only for saved articles
  saved: z.object({ unread: z.number() }).optional(),

  // Only for web/email entries (have subscriptions)
  subscription: z.object({ id: z.string(), unread: z.number() }).optional(),
  tags: z.array(z.object({ id: z.string(), unread: z.number() })).optional(),
  uncategorized: z.object({ unread: z.number() }).optional(),
});

/**
 * Schema for unread counts returned from bulk mutations (markRead).
 * Contains absolute counts for all affected lists.
 */
const bulkUnreadCountsSchema = z.object({
  // Always present
  all: z.object({ unread: z.number() }),
  starred: z.object({ unread: z.number() }),
  saved: z.object({ unread: z.number() }),

  // Per-subscription counts (only subscriptions that were affected)
  subscriptions: z.array(z.object({ id: z.string(), unread: z.number() })),

  // Per-tag counts (only tags that were affected)
  tags: z.array(z.object({ id: z.string(), unread: z.number() })),

  // Uncategorized count (if any affected subscription has no tags)
  uncategorized: z.object({ unread: z.number() }).optional(),
});

/**
 * Output schema for setStarred mutation.
 * Returns the updated entry with new starred state and counts.
 */
const setStarredOutputSchema = z.object({
  entry: entryMutationResultSchema,
  counts: unreadCountsSchema,
});

// ============================================================================
// Router
// ============================================================================
//
// Full-entry reads go through `entriesService.selectFullEntry` /
// `entriesService.toFullEntry`, which resolve the persisted sanitized content
// (the read-path sanitization chokepoint lives in the services layer so MCP,
// Google Reader, and Wallabag get the same guarantee).

export const entriesRouter = createTRPCRouter({
  /**
   * List entries with filters and cursor-based pagination.
   *
   * Supports optional full-text search via the query parameter.
   * When query is provided, searches both title and content and ranks by relevance.
   * Without query, returns entries sorted by time.
   *
   * @param query - Optional full-text search query (searches title and content)
   * @param subscriptionId - Optional filter by subscription ID
   * @param tagId - Optional filter by tag ID (entries from subscriptions with this tag)
   * @param uncategorized - Optional filter to show only entries from uncategorized subscriptions
   * @param type - Optional filter by entry type (web/email/saved)
   * @param excludeTypes - Optional array of types to exclude
   * @param unreadOnly - Optional filter to show only unread entries
   * @param starredOnly - Optional filter to show only starred entries
   * @param sortOrder - Optional sort order: "newest" (default) or "oldest". Ignored when query is provided.
   * @param cursor - Optional pagination cursor (from previous response)
   * @param limit - Optional number of entries per page (default: 50, max: 100)
   * @returns Paginated list of entries
   */
  list: mcpProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/entries",
        tags: ["Entries"],
        summary: "List entries",
      },
    })
    .input(
      z.object({
        query: z.string().optional(),
        subscriptionId: uuidSchema.optional(),
        tagId: uuidSchema.optional(),
        uncategorized: booleanQueryParam,
        type: feedTypeSchema.optional(),
        excludeTypes: z.array(feedTypeSchema).optional(),
        unreadOnly: booleanQueryParam,
        starredOnly: booleanQueryParam,
        sortOrder: sortOrderSchema,
        sortBy: sortBySchema,
        cursor: cursorSchema,
        limit: limitSchema,
      })
    )
    .output(entriesListOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const showSpam = ctx.session.user.showSpam;

      return entriesService.listEntries(ctx.db, {
        userId,
        query: input.query,
        subscriptionId: input.subscriptionId,
        tagId: input.tagId,
        uncategorized: input.uncategorized,
        type: input.type,
        excludeTypes: input.excludeTypes,
        unreadOnly: input.unreadOnly,
        starredOnly: input.starredOnly,
        sortOrder: input.sortOrder,
        sortBy: input.sortBy,
        cursor: input.cursor,
        limit: input.limit,
        showSpam,
      });
    }),

  /**
   * Get a single entry by ID with full content.
   *
   * The entry is visible to a user only if they have a corresponding
   * row in the user_entries table for their user_id.
   *
   * Includes subscription data (fetchFullContent, tags) to avoid separate
   * subscriptions.get query on the client.
   *
   * @param id - The entry ID
   * @returns The full entry with content and subscription data
   */
  get: mcpProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/entries/{id}",
        tags: ["Entries"],
        summary: "Get entry",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(z.object({ entry: entryFullSchema }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const row = await entriesService.selectFullEntry(ctx.db, userId, input.id);
      if (!row) {
        throw errors.entryNotFound();
      }

      return { entry: await entriesService.toFullEntry(ctx.db, row) };
    }),

  /**
   * Mark entries as read or unread (bulk operation).
   *
   * Only entries the user has access to (via user_entries) will be updated.
   * Returns entries with subscription context for client-side cache updates.
   *
   * Supports per-entry timestamps for offline sync scenarios where each entry
   * was marked at a different time.
   *
   * @param entries - Array of entry IDs with optional per-entry timestamps
   * @param read - Whether to mark as read (true) or unread (false)
   * @returns The updated entries with subscription context for cache updates
   */
  markRead: mcpProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/entries/mark-read",
        tags: ["Entries"],
        summary: "Mark entries read/unread",
      },
    })
    .input(
      z.object({
        entries: z
          .array(
            z.object({
              id: uuidSchema,
              changedAt: z.coerce.date().optional(),
            })
          )
          .min(1, "At least one entry is required")
          .max(1000, "Maximum 1000 entries per request"),
        read: z.boolean(),
        // Implicit score signal: set when marking read from the entry list
        fromList: z.boolean().optional(),
      })
    )
    .output(
      z.object({
        success: z.boolean(),
        count: z.number(),
        // Entries with context for cache updates
        entries: z.array(
          z.object({
            id: z.string(),
            subscriptionId: z.string().nullable(),
            read: z.boolean(), // Actual read state after update
            starred: z.boolean(), // For updating starred unread count
            type: feedTypeSchema, // For updating saved/email counts
            updatedAt: z.date(), // For cache freshness comparison
          })
        ),
        // Absolute counts for all affected lists
        counts: bulkUnreadCountsSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // markEntriesRead computes the absolute counts and publishes the
      // entry_state_changed SSE events itself (so every caller — tRPC, MCP, and
      // the Google Reader/Wallabag compat routes — notifies other tabs).
      const { entries: entriesResult, counts } = await entriesService.markEntriesRead(
        ctx.db,
        userId,
        input.entries,
        input.read,
        { fromList: input.fromList }
      );

      return {
        success: true,
        count: entriesResult.length,
        entries: entriesResult,
        counts,
      };
    }),

  /**
   * Mark all entries as read with optional filters.
   *
   * @param subscriptionId - Optional filter to mark only entries from a specific subscription
   * @param tagId - Optional filter to mark only entries from subscriptions with this tag
   * @param starredOnly - Optional filter to mark only starred entries
   * @param before - Optional filter to mark only entries fetched before this date
   * @returns The count of entries marked as read
   */
  markAllRead: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/entries/mark-all-read",
        tags: ["Entries"],
        summary: "Mark all entries read",
      },
    })
    .input(
      z.object({
        subscriptionId: uuidSchema.optional(),
        tagId: uuidSchema.optional(),
        uncategorized: z.boolean().optional(),
        starredOnly: z.boolean().optional(),
        type: feedTypeSchema.optional(),
        before: z.coerce.date().optional(),
        changedAt: z.coerce.date().optional(),
      })
    )
    .output(z.object({ count: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Validate tag belongs to user before passing to service
      if (input.tagId) {
        const tagExists = await ctx.db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.id, input.tagId), eq(tags.userId, userId)))
          .limit(1);

        if (tagExists.length === 0) {
          return { count: 0 };
        }
      }

      // Validate subscription belongs to user before passing to service
      if (input.subscriptionId) {
        const subFeedIds = await getSubscriptionFeedIds(ctx.db, input.subscriptionId, userId);
        if (subFeedIds === null) {
          return { count: 0 };
        }
      }

      // markAllEntriesRead publishes the mark_all_read SSE signal itself (so the
      // Google Reader mark-all-as-read route notifies other tabs too).
      const entryIds = await entriesService.markAllEntriesRead(ctx.db, {
        userId,
        subscriptionId: input.subscriptionId,
        tagId: input.tagId,
        uncategorized: input.uncategorized,
        starredOnly: input.starredOnly,
        type: input.type,
        before: input.before,
        changedAt: input.changedAt,
      });

      return { count: entryIds.length };
    }),

  /**
   * Set the starred status of an entry.
   *
   * The entry must be visible to the user (via user_entries).
   *
   * @param id - The entry ID to update
   * @param starred - Whether to star (true) or unstar (false)
   * @returns The updated entry with current state
   */
  setStarred: mcpProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/entries/{id}/starred",
        tags: ["Entries"],
        summary: "Set entry starred status",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
        starred: z.boolean(),
        changedAt: z.coerce.date().optional(),
      })
    )
    .output(setStarredOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      // updateEntryStarred computes the absolute counts and publishes the
      // entry_state_changed SSE event itself (so every caller — tRPC, MCP, and
      // the Google Reader/Wallabag compat routes — notifies other tabs).
      const { entry, counts } = await entriesService.updateEntryStarred(
        ctx.db,
        userId,
        input.id,
        input.starred,
        input.changedAt ?? new Date()
      );

      return { entry, counts };
    }),

  /**
   * Get count of entries with optional filters.
   *
   * Entries are visible to a user only if they have a corresponding
   * row in the user_entries table for their user_id.
   *
   * @param subscriptionId - Optional filter by subscription ID
   * @param tagId - Optional filter by tag ID (entries from subscriptions with this tag)
   * @param uncategorized - Optional filter to show only entries from uncategorized subscriptions
   * @param type - Optional filter by entry type
   * @param excludeTypes - Optional types to exclude
   * @param unreadOnly - Optional filter to count only unread entries
   * @param starredOnly - Optional filter to count only starred entries
   * @returns Count of total and unread entries
   */
  count: mcpProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/entries/count",
        tags: ["Entries"],
        summary: "Get entries count",
      },
    })
    .input(
      z
        .object({
          subscriptionId: uuidSchema.optional(),
          tagId: uuidSchema.optional(),
          uncategorized: booleanQueryParam,
          type: feedTypeSchema.optional(),
          excludeTypes: z.array(feedTypeSchema).optional(),
          unreadOnly: booleanQueryParam,
          starredOnly: booleanQueryParam,
        })
        .optional()
    )
    .output(
      z.object({
        unread: z.number(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Use the shared countEntries service function
      return entriesService.countEntries(ctx.db, ctx.session.user.id, {
        subscriptionId: input?.subscriptionId,
        tagId: input?.tagId,
        uncategorized: input?.uncategorized,
        type: input?.type,
        excludeTypes: input?.excludeTypes,
        unreadOnly: input?.unreadOnly,
        starredOnly: input?.starredOnly,
        showSpam: ctx.session.user.showSpam,
      });
    }),

  /**
   * Fetch full article content from URL.
   *
   * This mutation fetches the full article from the entry's URL,
   * processes it through Readability, and stores both the original
   * and cleaned versions.
   *
   * On success, it also invalidates any existing narration content
   * so that it will be regenerated using the full content.
   *
   * @param id - The entry ID to fetch full content for
   * @returns The updated entry with full content fields
   */
  fetchFullContent: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/entries/{id}/fetch-full-content",
        tags: ["Entries"],
        summary: "Fetch full article content",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(
      z.object({
        success: z.boolean(),
        entry: entryFullSchema.optional(),
        error: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      return fullContentService.fetchAndStoreFullContent(ctx.db, userId, input.id);
    }),
});
