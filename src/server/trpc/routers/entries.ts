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
import { eq, and, lte, inArray, notInArray, sql } from "drizzle-orm";
import { createHash } from "crypto";

import { createTRPCRouter, confirmedProtectedProcedure as protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { uuidSchema } from "../validation";
import {
  entries,
  feeds,
  subscriptionFeeds,
  userEntries,
  subscriptions,
  subscriptionTags,
  tags,
  visibleEntries,
  userFeeds,
  narrationContent,
} from "@/server/db/schema";
import { fetchFullContent as fetchFullContentFromUrl } from "@/server/services/full-content";
import * as entriesService from "@/server/services/entries";
import * as countsService from "@/server/services/counts";
import { publishEntryStateChanged } from "@/server/redis/pubsub";
import { logger } from "@/lib/logger";

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
const sortBySchema = z.enum(["published", "readChanged", "predictedScore"]).optional();

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
  score: z.number().nullable(),
  implicitScore: z.number(),
  predictedScore: z.number().nullable(),
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
  // Score fields
  score: z.number().nullable(),
  implicitScore: z.number(),
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
  score: z.number().nullable(),
  implicitScore: z.number(),
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
// Helper Functions
// ============================================================================

/**
 * Database context type for helper functions.
 */
type DbContext = {
  db: typeof import("@/server/db").db;
};

/**
 * Looks up the feed IDs for a subscription.
 * Returns all feed IDs from the subscription_feeds junction table (current feed + previous feeds from redirects).
 * Validates subscription ownership via user_feeds view.
 *
 * @param db - Database instance
 * @param subscriptionId - The subscription ID to look up
 * @param userId - The user ID (for access control)
 * @returns Array of feed IDs, or null if subscription not found
 */
async function getSubscriptionFeedIds(
  db: typeof import("@/server/db").db,
  subscriptionId: string,
  userId: string
): Promise<string[] | null> {
  // Verify subscription exists and belongs to user
  const subExists = await db
    .select({ id: userFeeds.id })
    .from(userFeeds)
    .where(and(eq(userFeeds.id, subscriptionId), eq(userFeeds.userId, userId)))
    .limit(1);

  if (subExists.length === 0) {
    return null;
  }

  const result = await db
    .select({ feedId: subscriptionFeeds.feedId })
    .from(subscriptionFeeds)
    .where(eq(subscriptionFeeds.subscriptionId, subscriptionId));

  return result.map((r) => r.feedId);
}

// ============================================================================
// Shared Select Fields
// ============================================================================

/**
 * Fields to select when fetching a full entry from visibleEntries + feeds + subscriptions.
 * Used by both `get` and `fetchFullContent` to avoid duplicating the 20+ field list.
 */
const fullEntrySelectFields = {
  id: visibleEntries.id,
  feedId: visibleEntries.feedId,
  type: visibleEntries.type,
  url: visibleEntries.url,
  title: visibleEntries.title,
  author: visibleEntries.author,
  contentOriginal: visibleEntries.contentOriginal,
  contentCleaned: visibleEntries.contentCleaned,
  summary: visibleEntries.summary,
  publishedAt: visibleEntries.publishedAt,
  fetchedAt: visibleEntries.fetchedAt,
  read: visibleEntries.read,
  starred: visibleEntries.starred,
  updatedAt: visibleEntries.updatedAt,
  subscriptionId: visibleEntries.subscriptionId,
  siteName: visibleEntries.siteName,
  feedTitle: feeds.title,
  feedUrl: feeds.url,
  unsubscribeUrl: visibleEntries.unsubscribeUrl,
  fullContentOriginal: visibleEntries.fullContentOriginal,
  fullContentCleaned: visibleEntries.fullContentCleaned,
  fullContentFetchedAt: visibleEntries.fullContentFetchedAt,
  fullContentError: visibleEntries.fullContentError,
  score: visibleEntries.score,
  contentHash: visibleEntries.contentHash,
  hasMarkedReadOnList: visibleEntries.hasMarkedReadOnList,
  hasMarkedUnread: visibleEntries.hasMarkedUnread,
  hasStarred: visibleEntries.hasStarred,
  fetchFullContent: subscriptions.fetchFullContent,
};

/**
 * Fetch a single full entry by ID for a user.
 * Queries visibleEntries joined with feeds and subscriptions.
 * Returns null if the entry is not found or not visible to the user.
 */
async function selectFullEntry(
  db: typeof import("@/server/db").db,
  userId: string,
  entryId: string
) {
  const result = await db
    .select(fullEntrySelectFields)
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .leftJoin(subscriptions, eq(visibleEntries.subscriptionId, subscriptions.id))
    .where(and(eq(visibleEntries.id, entryId), eq(visibleEntries.userId, userId)))
    .limit(1);

  return result.length > 0 ? result[0] : null;
}

/**
 * Transform a raw full entry row into the entryFullSchema shape.
 * Computes implicitScore from the boolean signal flags and defaults fetchFullContent.
 */
function toFullEntry(row: NonNullable<Awaited<ReturnType<typeof selectFullEntry>>>) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { hasStarred, hasMarkedUnread, hasMarkedReadOnList, contentHash, ...rest } = row;
  return {
    ...rest,
    implicitScore: entriesService.computeImplicitScore(
      hasStarred,
      hasMarkedUnread,
      hasMarkedReadOnList,
      row.type
    ),
    fetchFullContent: row.fetchFullContent ?? false,
  };
}

// ============================================================================
// Mutation Helpers
// ============================================================================

/**
 * Updates the starred status of an entry for a user.
 * Uses idempotent conditional updates: only applies if changedAt is newer than stored timestamp.
 *
 * @param ctx - Database context
 * @param userId - The user ID
 * @param entryId - The entry ID
 * @param starred - Whether to star (true) or unstar (false)
 * @param changedAt - When the user initiated the action. Defaults to now.
 * @returns The final entry state (may differ from requested if a newer change exists)
 * @throws entryNotFound if entry doesn't exist or user doesn't have access
 */
async function updateEntryStarred(
  ctx: DbContext,
  userId: string,
  entryId: string,
  starred: boolean,
  changedAt: Date = new Date()
): Promise<{
  id: string;
  read: boolean;
  starred: boolean;
  updatedAt: Date;
  score: number | null;
  implicitScore: number;
}> {
  // Build SET clause, including hasStarred flag when starring
  const setClause: Record<string, unknown> = {
    starred,
    starredChangedAt: changedAt,
    updatedAt: new Date(),
  };

  // Set implicit signal flag when starring (not when unstarring)
  if (starred) {
    setClause.hasStarred = true;
  }

  // Conditional update: only apply if incoming timestamp is newer
  await ctx.db
    .update(userEntries)
    .set(setClause)
    .where(
      and(
        eq(userEntries.userId, userId),
        eq(userEntries.entryId, entryId),
        lte(userEntries.starredChangedAt, changedAt)
      )
    );

  // Always return final state from visibleEntries (includes computed updatedAt)
  const result = await ctx.db
    .select({
      id: visibleEntries.id,
      read: visibleEntries.read,
      starred: visibleEntries.starred,
      updatedAt: visibleEntries.updatedAt,
      score: visibleEntries.score,
      hasMarkedReadOnList: visibleEntries.hasMarkedReadOnList,
      hasMarkedUnread: visibleEntries.hasMarkedUnread,
      hasStarred: visibleEntries.hasStarred,
      type: visibleEntries.type,
    })
    .from(visibleEntries)
    .where(and(eq(visibleEntries.userId, userId), eq(visibleEntries.id, entryId)));

  if (result.length === 0) {
    throw errors.entryNotFound();
  }

  const row = result[0];
  return {
    id: row.id,
    read: row.read,
    starred: row.starred,
    updatedAt: row.updatedAt,
    score: row.score,
    implicitScore: entriesService.computeImplicitScore(
      row.hasStarred,
      row.hasMarkedUnread,
      row.hasMarkedReadOnList,
      row.type
    ),
  };
}

// ============================================================================
// Router
// ============================================================================

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
  list: protectedProcedure
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
        bestFeedScoreWeight: ctx.session.user.bestFeedScoreWeight,
        bestFeedUncertaintyWeight: ctx.session.user.bestFeedUncertaintyWeight,
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
  get: protectedProcedure
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

      const row = await selectFullEntry(ctx.db, userId, input.id);
      if (!row) {
        throw errors.entryNotFound();
      }

      return { entry: toFullEntry(row) };
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
  markRead: protectedProcedure
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
            score: z.number().nullable(), // For updating score display
            implicitScore: z.number(), // For updating score display
          })
        ),
        // Absolute counts for all affected lists
        counts: bulkUnreadCountsSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const now = new Date();

      // Build the SET clause, optionally including implicit signal flags
      const setClause: Record<string, unknown> = {
        read: input.read,
        updatedAt: now,
      };

      // Set implicit score signals based on the action and source
      if (input.read && input.fromList) {
        // Marking read from the entry list → implicit -1
        setClause.hasMarkedReadOnList = true;
      } else if (!input.read) {
        // Marking unread from anywhere → implicit +1
        setClause.hasMarkedUnread = true;
      }

      // Group entries by timestamp for efficient batch updates
      // Most cases (interactive use) will have all entries with same/no timestamp
      const entriesByTimestamp = new Map<string, string[]>();
      for (const entry of input.entries) {
        const ts = (entry.changedAt ?? now).toISOString();
        const existing = entriesByTimestamp.get(ts) ?? [];
        existing.push(entry.id);
        entriesByTimestamp.set(ts, existing);
      }

      // Batch update for each timestamp group
      for (const [tsIso, entryIds] of entriesByTimestamp) {
        const changedAt = new Date(tsIso);
        await ctx.db
          .update(userEntries)
          .set({
            ...setClause,
            readChangedAt: changedAt,
          })
          .where(
            and(
              eq(userEntries.userId, userId),
              inArray(userEntries.entryId, entryIds),
              lte(userEntries.readChangedAt, changedAt)
            )
          );
      }

      // Always return final state for all requested entries
      const allEntryIds = input.entries.map((e) => e.id);
      const entrySubscriptions = await ctx.db
        .select({
          id: visibleEntries.id,
          subscriptionId: visibleEntries.subscriptionId,
          read: visibleEntries.read,
          starred: visibleEntries.starred,
          type: visibleEntries.type,
          updatedAt: visibleEntries.updatedAt,
          score: visibleEntries.score,
          hasMarkedReadOnList: visibleEntries.hasMarkedReadOnList,
          hasMarkedUnread: visibleEntries.hasMarkedUnread,
          hasStarred: visibleEntries.hasStarred,
        })
        .from(visibleEntries)
        .where(and(eq(visibleEntries.userId, userId), inArray(visibleEntries.id, allEntryIds)));

      const entriesResult = entrySubscriptions.map((e) => ({
        id: e.id,
        subscriptionId: e.subscriptionId,
        read: e.read,
        starred: e.starred,
        type: e.type,
        updatedAt: e.updatedAt,
        score: e.score,
        implicitScore: entriesService.computeImplicitScore(
          e.hasStarred,
          e.hasMarkedUnread,
          e.hasMarkedReadOnList,
          e.type
        ),
      }));

      // Get absolute counts for all affected lists
      const counts = await countsService.getBulkEntryRelatedCounts(ctx.db, userId, entriesResult);

      // Publish entry state change events for multi-tab/device sync
      // Fire and forget - don't block the response
      for (const entry of entriesResult) {
        publishEntryStateChanged(
          userId,
          entry.id,
          entry.read,
          entry.starred,
          entry.updatedAt
        ).catch(() => {
          // Ignore publish errors - SSE is best-effort
        });
      }

      return {
        success: true,
        count: entrySubscriptions.length,
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
      const changedAt = input.changedAt ?? new Date();

      // Build conditions for the update using subqueries to avoid sequential queries
      // Note: We also require readChangedAt <= changedAt for idempotency
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conditions: any[] = [
        eq(userEntries.userId, userId),
        eq(userEntries.read, false),
        lte(userEntries.readChangedAt, changedAt),
      ];

      // Filter by subscriptionId - need to look up feed IDs first for validation
      if (input.subscriptionId) {
        const subFeedIds = await getSubscriptionFeedIds(ctx.db, input.subscriptionId, userId);
        if (subFeedIds === null) {
          return { count: 0 };
        }
        // Use subquery to filter entries by feed IDs instead of fetching all IDs
        const entryIdsSubquery = ctx.db
          .select({ id: entries.id })
          .from(entries)
          .where(inArray(entries.feedId, subFeedIds));

        conditions.push(inArray(userEntries.entryId, entryIdsSubquery));
      }

      // If tagId is provided, filter entries by feeds with this tag
      if (input.tagId) {
        // First verify the tag belongs to the user
        const tagExists = await ctx.db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.id, input.tagId), eq(tags.userId, userId)))
          .limit(1);

        if (tagExists.length === 0) {
          // Tag not found or doesn't belong to user
          return { count: 0 };
        }

        // Subquery for feed IDs of subscriptions with this tag via subscription_feeds junction table
        const taggedFeedIdsSubquery = ctx.db
          .select({ feedId: subscriptionFeeds.feedId })
          .from(subscriptionTags)
          .innerJoin(
            subscriptionFeeds,
            eq(subscriptionTags.subscriptionId, subscriptionFeeds.subscriptionId)
          )
          .where(eq(subscriptionTags.tagId, input.tagId));

        // Subquery for entry IDs from tagged feeds
        const taggedEntryIdsSubquery = ctx.db
          .select({ id: entries.id })
          .from(entries)
          .where(inArray(entries.feedId, taggedFeedIdsSubquery));

        conditions.push(inArray(userEntries.entryId, taggedEntryIdsSubquery));
      }

      // If uncategorized is true, filter entries by feeds with no tags
      if (input.uncategorized) {
        // Subquery for subscription IDs that have tags
        const taggedSubscriptionIdsSubquery = ctx.db
          .select({ subscriptionId: subscriptionTags.subscriptionId })
          .from(subscriptionTags);

        // Subquery for feed IDs from uncategorized subscriptions (no tags) via subscription_feeds
        const uncategorizedFeedIdsSubquery = ctx.db
          .select({ feedId: subscriptionFeeds.feedId })
          .from(userFeeds)
          .innerJoin(subscriptionFeeds, eq(subscriptionFeeds.subscriptionId, userFeeds.id))
          .where(
            and(
              eq(userFeeds.userId, userId),
              notInArray(userFeeds.id, taggedSubscriptionIdsSubquery)
            )
          );

        // Subquery for entry IDs from uncategorized feeds
        const uncategorizedEntryIdsSubquery = ctx.db
          .select({ id: entries.id })
          .from(entries)
          .where(inArray(entries.feedId, uncategorizedFeedIdsSubquery));

        conditions.push(inArray(userEntries.entryId, uncategorizedEntryIdsSubquery));
      }

      // If starredOnly is true, filter to only starred entries
      if (input.starredOnly) {
        conditions.push(eq(userEntries.starred, true));
      }

      // If type is provided, filter entries by feed type using subquery
      if (input.type) {
        const typeEntryIdsSubquery = ctx.db
          .select({ id: entries.id })
          .from(entries)
          .innerJoin(feeds, eq(entries.feedId, feeds.id))
          .where(eq(feeds.type, input.type));

        conditions.push(inArray(userEntries.entryId, typeEntryIdsSubquery));
      }

      // If before date is provided, filter entries by fetchedAt using subquery
      if (input.before) {
        const beforeEntryIdsSubquery = ctx.db
          .select({ id: entries.id })
          .from(entries)
          .where(lte(entries.fetchedAt, input.before));

        conditions.push(inArray(userEntries.entryId, beforeEntryIdsSubquery));
      }

      // Use a single query with RETURNING to both update and count
      const result = await ctx.db
        .update(userEntries)
        .set({
          read: true,
          readChangedAt: changedAt,
          updatedAt: new Date(),
        })
        .where(and(...conditions))
        .returning({ entryId: userEntries.entryId });

      return { count: result.length };
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
  setStarred: protectedProcedure
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
      const entry = await updateEntryStarred(
        ctx,
        userId,
        input.id,
        input.starred,
        input.changedAt ?? new Date()
      );
      const counts = await countsService.getEntryRelatedCounts(ctx.db, userId, input.id);

      // Publish entry state change event for multi-tab/device sync
      // Fire and forget - don't block the response
      publishEntryStateChanged(userId, entry.id, entry.read, entry.starred, entry.updatedAt).catch(
        () => {
          // Ignore publish errors - SSE is best-effort
        }
      );

      return { entry, counts };
    }),

  /**
   * Set the explicit score for an entry.
   *
   * Score values: -2, -1, 0, 1, 2, or null to clear the explicit vote.
   * Uses idempotent timestamp-based updates.
   *
   * @param id - The entry ID
   * @param score - The score to set (-2 to +2), or null to clear
   * @returns The updated entry with score state
   */
  setScore: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/entries/{id}/score",
        tags: ["Entries"],
        summary: "Set entry score",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
        score: z.number().int().min(-2).max(2).nullable(),
        changedAt: z.coerce.date().optional(),
      })
    )
    .output(
      z.object({
        entry: entryMutationResultSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const entry = await entriesService.setEntryScore(
        ctx.db,
        ctx.session.user.id,
        input.id,
        input.score,
        input.changedAt ?? new Date()
      );
      return { entry };
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
  count: protectedProcedure
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
   * Check if the user has scored any entries and has the algorithmic feed enabled.
   *
   * Returns true if the user has the algorithmic feed enabled AND has explicitly
   * scored at least one entry, which is the prerequisite for the algorithmic feed
   * to be useful.
   */
  hasScoredEntries: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/entries/has-scored",
        tags: ["Entries"],
        summary: "Check if user has scored entries",
      },
    })
    .output(z.object({ hasScoredEntries: z.boolean() }))
    .query(async ({ ctx }) => {
      // Short-circuit: if algorithmic feed is disabled, no need to query
      if (!ctx.session.user.algorithmicFeedEnabled) {
        return { hasScoredEntries: false };
      }

      const userId = ctx.session.user.id;
      const result = await ctx.db
        .select({ id: userEntries.entryId })
        .from(userEntries)
        .where(and(eq(userEntries.userId, userId), sql`${userEntries.score} IS NOT NULL`))
        .limit(1);

      return { hasScoredEntries: result.length > 0 };
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

      // First, verify the entry exists and user has access
      const rawEntry = await selectFullEntry(ctx.db, userId, input.id);

      if (!rawEntry) {
        throw errors.entryNotFound();
      }

      const entry = {
        ...toFullEntry(rawEntry),
        contentHash: rawEntry.contentHash,
      };

      // Check if entry has a URL to fetch
      if (!entry.url) {
        return {
          success: false,
          error: "Entry has no URL to fetch content from",
        };
      }

      // Fetch the full content
      logger.info("Fetching full content for entry", {
        entryId: entry.id,
        url: entry.url,
      });

      const result = await fetchFullContentFromUrl(entry.url);

      if (!result.success) {
        // Update entry with error
        await ctx.db
          .update(entries)
          .set({
            fullContentError: result.error ?? "Unknown error",
            fullContentFetchedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(entries.id, input.id));

        logger.warn("Failed to fetch full content", {
          entryId: entry.id,
          url: entry.url,
          error: result.error,
        });

        return {
          success: false,
          error: result.error,
          entry: {
            ...entry,
            fullContentError: result.error ?? "Unknown error",
            fullContentFetchedAt: new Date(),
          },
        };
      }

      // Compute hash of full content for separate summary caching
      const fullContentForHash = result.contentCleaned ?? result.contentOriginal ?? "";
      const fullContentHash = fullContentForHash
        ? createHash("sha256").update(fullContentForHash, "utf8").digest("hex")
        : null;

      // Update entry with full content
      const now = new Date();
      await ctx.db
        .update(entries)
        .set({
          fullContentOriginal: result.contentOriginal ?? null,
          fullContentCleaned: result.contentCleaned ?? null,
          fullContentHash,
          fullContentFetchedAt: now,
          fullContentError: null,
          updatedAt: now,
        })
        .where(eq(entries.id, input.id));

      // Invalidate any existing narration content so it will be regenerated
      // using the full content next time narration is requested
      if (entry.contentHash) {
        await ctx.db
          .update(narrationContent)
          .set({
            contentNarration: null,
            generatedAt: null,
            error: null,
            errorAt: null,
          })
          .where(eq(narrationContent.contentHash, entry.contentHash));

        logger.debug("Invalidated narration content for entry", {
          entryId: entry.id,
          contentHash: entry.contentHash,
        });
      }

      logger.info("Successfully fetched full content for entry", {
        entryId: entry.id,
        url: entry.url,
        contentLength: result.contentCleaned?.length,
      });

      return {
        success: true,
        entry: {
          ...entry,
          fullContentOriginal: result.contentOriginal ?? null,
          fullContentCleaned: result.contentCleaned ?? null,
          fullContentFetchedAt: now,
          fullContentError: null,
        },
      };
    }),
});
