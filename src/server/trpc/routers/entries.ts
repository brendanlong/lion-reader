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
import { eq, and, desc, asc, lte, lt, inArray, notInArray, sql } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import {
  entries,
  feeds,
  userEntries,
  subscriptionTags,
  tags,
  visibleEntries,
  userFeeds,
  narrationContent,
} from "@/server/db/schema";
import { fetchFullContent as fetchFullContentFromUrl } from "@/server/services/full-content";
import { countEntries } from "@/server/services/entries";
import { logger } from "@/lib/logger";

// ============================================================================
// Constants
// ============================================================================

/**
 * Default number of entries to return per page.
 */
const DEFAULT_LIMIT = 50;

/**
 * Maximum number of entries that can be requested per page.
 */
const MAX_LIMIT = 100;

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * UUID validation schema for entry IDs.
 */
const uuidSchema = z.string().uuid("Invalid entry ID");

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
 * Search field validation schema.
 */
const searchInSchema = z.enum(["title", "content", "both"]).optional();

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
  feedTitle: z.string().nullable(),
  feedUrl: z.string().nullable(),
  siteName: z.string().nullable(),
  // Full content fields
  fullContentOriginal: z.string().nullable(),
  fullContentCleaned: z.string().nullable(),
  fullContentFetchedAt: z.date().nullable(),
  fullContentError: z.string().nullable(),
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
 * Contains minimal fields needed for optimistic updates.
 */
const entryMutationResultSchema = z.object({
  id: z.string(),
  read: z.boolean(),
  starred: z.boolean(),
});

/**
 * Output schema for star/unstar mutations.
 * Returns the updated entry with new starred state.
 */
const starOutputSchema = z.object({
  entry: entryMutationResultSchema,
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Cursor data for pagination.
 * Uses compound cursor with timestamp + ID to handle entries with same timestamp.
 */
interface CursorData {
  /** ISO timestamp string for the sort column (publishedAt or fetchedAt) */
  ts: string;
  /** Entry ID as tiebreaker */
  id: string;
}

/**
 * Decodes a cursor to get the timestamp and entry ID.
 * Cursor is base64-encoded JSON with { ts, id }.
 *
 * @param cursor - The cursor string
 * @returns The decoded cursor data
 */
function decodeCursor(cursor: string): CursorData {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as CursorData;
    if (!parsed.ts || !parsed.id) {
      throw new Error("Invalid cursor structure");
    }
    return parsed;
  } catch {
    throw errors.validation("Invalid cursor format");
  }
}

/**
 * Encodes cursor data for pagination.
 *
 * @param ts - The timestamp (publishedAt or fetchedAt)
 * @param entryId - The entry ID
 * @returns The encoded cursor
 */
function encodeCursor(ts: Date, entryId: string): string {
  const data: CursorData = { ts: ts.toISOString(), id: entryId };
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64");
}

/**
 * Database context type for helper functions.
 */
type DbContext = {
  db: typeof import("@/server/db").db;
};

/**
 * Looks up the feed IDs for a subscription.
 * Returns the subscription's feed_ids array (current feed + previous feeds from redirects).
 * Uses user_feeds view which already filters out unsubscribed entries.
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
  const result = await db
    .select({ feedIds: userFeeds.feedIds })
    .from(userFeeds)
    .where(and(eq(userFeeds.id, subscriptionId), eq(userFeeds.userId, userId)))
    .limit(1);

  return result.length > 0 ? result[0].feedIds : null;
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
): Promise<{ id: string; read: boolean; starred: boolean }> {
  // Conditional update: only apply if incoming timestamp is newer
  await ctx.db
    .update(userEntries)
    .set({
      starred,
      starredChangedAt: changedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userEntries.userId, userId),
        eq(userEntries.entryId, entryId),
        lt(userEntries.starredChangedAt, changedAt)
      )
    );

  // Always return final state
  const result = await ctx.db
    .select({
      id: userEntries.entryId,
      read: userEntries.read,
      starred: userEntries.starred,
    })
    .from(userEntries)
    .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));

  if (result.length === 0) {
    throw errors.entryNotFound();
  }

  return result[0];
}

// ============================================================================
// Router
// ============================================================================

export const entriesRouter = createTRPCRouter({
  /**
   * List entries with filters and cursor-based pagination.
   *
   * Entries are visible to a user only if they have a corresponding
   * row in the user_entries table for their user_id.
   *
   * @param subscriptionId - Optional filter by subscription ID
   * @param tagId - Optional filter by tag ID (entries from subscriptions with this tag)
   * @param unreadOnly - Optional filter to show only unread entries
   * @param starredOnly - Optional filter to show only starred entries
   * @param sortOrder - Optional sort order: "newest" (default) or "oldest"
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
        subscriptionId: uuidSchema.optional(),
        tagId: uuidSchema.optional(),
        uncategorized: booleanQueryParam,
        type: feedTypeSchema.optional(),
        excludeTypes: z.array(feedTypeSchema).optional(),
        unreadOnly: booleanQueryParam,
        starredOnly: booleanQueryParam,
        sortOrder: sortOrderSchema,
        cursor: cursorSchema,
        limit: limitSchema,
      })
    )
    .output(entriesListOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const limit = input.limit ?? DEFAULT_LIMIT;
      const sortOrder = input.sortOrder ?? "newest";

      // Build the base query conditions using visible_entries view
      // The view already enforces visibility (active subscription OR starred)
      const conditions = [eq(visibleEntries.userId, userId)];

      // Filter by subscriptionId
      if (input.subscriptionId) {
        const feedIds = await getSubscriptionFeedIds(ctx.db, input.subscriptionId, userId);
        if (feedIds === null) {
          // Subscription not found or doesn't belong to user
          return { items: [], nextCursor: undefined };
        }
        conditions.push(inArray(visibleEntries.feedId, feedIds));
      }

      // Filter by tagId if specified
      if (input.tagId) {
        // First verify the tag belongs to the user
        const tagExists = await ctx.db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.id, input.tagId), eq(tags.userId, userId)))
          .limit(1);

        if (tagExists.length === 0) {
          // Tag not found or doesn't belong to user, return empty result
          return { items: [], nextCursor: undefined };
        }

        // Get feed IDs for subscriptions with this tag using user_feeds view
        const taggedFeedIds = ctx.db
          .select({ feedId: sql<string>`unnest(${userFeeds.feedIds})`.as("feed_id") })
          .from(subscriptionTags)
          .innerJoin(userFeeds, eq(subscriptionTags.subscriptionId, userFeeds.id))
          .where(eq(subscriptionTags.tagId, input.tagId));
        conditions.push(inArray(visibleEntries.feedId, taggedFeedIds));
      }

      // Filter by uncategorized if specified
      if (input.uncategorized) {
        // Get subscription IDs that have tags
        const taggedSubscriptionIds = ctx.db
          .select({ subscriptionId: subscriptionTags.subscriptionId })
          .from(subscriptionTags);

        // Get feed IDs for subscriptions with no tags using user_feeds view
        const uncategorizedFeedIds = ctx.db
          .select({ feedId: sql<string>`unnest(${userFeeds.feedIds})`.as("feed_id") })
          .from(userFeeds)
          .where(
            and(eq(userFeeds.userId, userId), notInArray(userFeeds.id, taggedSubscriptionIds))
          );

        conditions.push(inArray(visibleEntries.feedId, uncategorizedFeedIds));
      }

      // Apply unreadOnly filter
      if (input.unreadOnly) {
        conditions.push(eq(visibleEntries.read, false));
      }

      // Apply starredOnly filter
      if (input.starredOnly) {
        conditions.push(eq(visibleEntries.starred, true));
      }

      // Apply type filter if specified
      if (input.type) {
        conditions.push(eq(visibleEntries.type, input.type));
      }

      // Apply excludeTypes filter if specified
      if (input.excludeTypes && input.excludeTypes.length > 0) {
        conditions.push(notInArray(visibleEntries.type, input.excludeTypes));
      }

      // Apply spam filter: exclude spam entries unless user has showSpam enabled
      const showSpam = ctx.session.user.showSpam;
      if (!showSpam) {
        conditions.push(eq(visibleEntries.isSpam, false));
      }

      // Sort by publishedAt, falling back to fetchedAt if null
      // Use entry.id as tiebreaker for stable ordering
      const sortColumn = sql`COALESCE(${visibleEntries.publishedAt}, ${visibleEntries.fetchedAt})`;

      // Add cursor condition if present
      // Uses compound comparison: (sortColumn, id) for stable pagination
      if (input.cursor) {
        const { ts, id } = decodeCursor(input.cursor);
        const cursorTs = new Date(ts);
        if (sortOrder === "newest") {
          // Entries older than cursor, or same timestamp with smaller ID
          conditions.push(
            sql`(${sortColumn} < ${cursorTs} OR (${sortColumn} = ${cursorTs} AND ${visibleEntries.id} < ${id}))`
          );
        } else {
          // Entries newer than cursor, or same timestamp with larger ID
          conditions.push(
            sql`(${sortColumn} > ${cursorTs} OR (${sortColumn} = ${cursorTs} AND ${visibleEntries.id} > ${id}))`
          );
        }
      }

      // Query entries using visible_entries view
      // The view already includes entry data, user state (read/starred), and subscription_id
      // Just need to join feeds for feedTitle
      const orderByClause =
        sortOrder === "newest"
          ? [desc(sortColumn), desc(visibleEntries.id)]
          : [asc(sortColumn), asc(visibleEntries.id)];
      const queryResults = await ctx.db
        .select({
          id: visibleEntries.id,
          feedId: visibleEntries.feedId,
          type: visibleEntries.type,
          url: visibleEntries.url,
          title: visibleEntries.title,
          author: visibleEntries.author,
          summary: visibleEntries.summary,
          publishedAt: visibleEntries.publishedAt,
          fetchedAt: visibleEntries.fetchedAt,
          read: visibleEntries.read,
          starred: visibleEntries.starred,
          subscriptionId: visibleEntries.subscriptionId,
          siteName: visibleEntries.siteName,
          feedTitle: feeds.title,
        })
        .from(visibleEntries)
        .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
        .where(and(...conditions))
        .orderBy(...orderByClause)
        .limit(limit + 1);

      // Determine if there are more results
      const hasMore = queryResults.length > limit;
      const resultEntries = hasMore ? queryResults.slice(0, limit) : queryResults;

      // Format the output
      const items = resultEntries.map((row) => ({
        id: row.id,
        subscriptionId: row.subscriptionId,
        feedId: row.feedId,
        type: row.type,
        url: row.url,
        title: row.title,
        author: row.author,
        summary: row.summary,
        publishedAt: row.publishedAt,
        fetchedAt: row.fetchedAt,
        read: row.read,
        starred: row.starred,
        feedTitle: row.feedTitle,
        siteName: row.siteName,
      }));

      // Generate next cursor if there are more results
      let nextCursor: string | undefined;
      if (hasMore && resultEntries.length > 0) {
        const lastEntry = resultEntries[resultEntries.length - 1];
        const lastTs = lastEntry.publishedAt ?? lastEntry.fetchedAt;
        nextCursor = encodeCursor(lastTs, lastEntry.id);
      }

      return { items, nextCursor };
    }),

  /**
   * Search entries by title and/or content using PostgreSQL full-text search.
   *
   * Results are ranked by relevance and support the same filters as list.
   *
   * @param query - The search query text
   * @param searchIn - Where to search: "title", "content", or "both" (default)
   * @param subscriptionId - Optional filter by subscription ID
   * @param tagId - Optional filter by tag ID
   * @param unreadOnly - Optional filter to show only unread entries
   * @param starredOnly - Optional filter to show only starred entries
   * @param cursor - Optional pagination cursor (from previous response)
   * @param limit - Optional number of entries per page (default: 50, max: 100)
   * @returns Paginated list of matching entries, ranked by relevance
   */
  search: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/entries/search",
        tags: ["Entries"],
        summary: "Search entries",
      },
    })
    .input(
      z.object({
        query: z.string().min(1, "Search query is required"),
        searchIn: searchInSchema,
        subscriptionId: uuidSchema.optional(),
        tagId: uuidSchema.optional(),
        uncategorized: booleanQueryParam,
        type: feedTypeSchema.optional(),
        excludeTypes: z.array(feedTypeSchema).optional(),
        unreadOnly: booleanQueryParam,
        starredOnly: booleanQueryParam,
        cursor: cursorSchema,
        limit: limitSchema,
      })
    )
    .output(entriesListOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const limit = input.limit ?? DEFAULT_LIMIT;
      const searchIn = input.searchIn ?? "both";

      // Build the base query conditions using visible_entries view
      const conditions = [eq(visibleEntries.userId, userId)];

      // Build full-text search vector based on searchIn parameter
      let searchVector: ReturnType<typeof sql>;
      if (searchIn === "title") {
        searchVector = sql`to_tsvector('english', COALESCE(${visibleEntries.title}, ''))`;
      } else if (searchIn === "content") {
        searchVector = sql`to_tsvector('english', COALESCE(${visibleEntries.contentCleaned}, ''))`;
      } else {
        // both
        searchVector = sql`to_tsvector('english', COALESCE(${visibleEntries.title}, '') || ' ' || COALESCE(${visibleEntries.contentCleaned}, ''))`;
      }

      // Create the search query
      const searchQuery = sql`plainto_tsquery('english', ${input.query})`;

      // Add full-text search condition
      conditions.push(sql`${searchVector} @@ ${searchQuery}`);

      // Calculate relevance rank for sorting
      const rankColumn = sql<number>`ts_rank(${searchVector}, ${searchQuery})`;

      // Filter by subscriptionId
      if (input.subscriptionId) {
        const feedIds = await getSubscriptionFeedIds(ctx.db, input.subscriptionId, userId);
        if (feedIds === null) {
          return { items: [], nextCursor: undefined };
        }
        conditions.push(inArray(visibleEntries.feedId, feedIds));
      }

      // Filter by tagId if specified
      if (input.tagId) {
        const tagExists = await ctx.db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.id, input.tagId), eq(tags.userId, userId)))
          .limit(1);

        if (tagExists.length === 0) {
          return { items: [], nextCursor: undefined };
        }

        const taggedFeedIds = ctx.db
          .select({ feedId: sql<string>`unnest(${userFeeds.feedIds})`.as("feed_id") })
          .from(subscriptionTags)
          .innerJoin(userFeeds, eq(subscriptionTags.subscriptionId, userFeeds.id))
          .where(eq(subscriptionTags.tagId, input.tagId));
        conditions.push(inArray(visibleEntries.feedId, taggedFeedIds));
      }

      // Filter by uncategorized if specified
      if (input.uncategorized) {
        const taggedSubscriptionIds = ctx.db
          .select({ subscriptionId: subscriptionTags.subscriptionId })
          .from(subscriptionTags);

        const uncategorizedFeedIds = ctx.db
          .select({ feedId: sql<string>`unnest(${userFeeds.feedIds})`.as("feed_id") })
          .from(userFeeds)
          .where(
            and(eq(userFeeds.userId, userId), notInArray(userFeeds.id, taggedSubscriptionIds))
          );

        conditions.push(inArray(visibleEntries.feedId, uncategorizedFeedIds));
      }

      // Apply unreadOnly filter
      if (input.unreadOnly) {
        conditions.push(eq(visibleEntries.read, false));
      }

      // Apply starredOnly filter
      if (input.starredOnly) {
        conditions.push(eq(visibleEntries.starred, true));
      }

      // Apply type filter if specified
      if (input.type) {
        conditions.push(eq(visibleEntries.type, input.type));
      }

      // Apply excludeTypes filter if specified
      if (input.excludeTypes && input.excludeTypes.length > 0) {
        conditions.push(notInArray(visibleEntries.type, input.excludeTypes));
      }

      // Apply spam filter
      const showSpam = ctx.session.user.showSpam;
      if (!showSpam) {
        conditions.push(eq(visibleEntries.isSpam, false));
      }

      // For search results, we use rank for primary sorting, with ID as tiebreaker
      // Cursor contains { rank, id } for pagination
      if (input.cursor) {
        const { ts: rankStr, id } = decodeCursor(input.cursor);
        const cursorRank = parseFloat(rankStr);
        // Results with lower rank than cursor, or same rank with smaller ID
        conditions.push(
          sql`(${rankColumn} < ${cursorRank} OR (${rankColumn} = ${cursorRank} AND ${visibleEntries.id} < ${id}))`
        );
      }

      // Query entries, ordered by relevance rank (descending), then ID
      const queryResults = await ctx.db
        .select({
          id: visibleEntries.id,
          feedId: visibleEntries.feedId,
          type: visibleEntries.type,
          url: visibleEntries.url,
          title: visibleEntries.title,
          author: visibleEntries.author,
          summary: visibleEntries.summary,
          publishedAt: visibleEntries.publishedAt,
          fetchedAt: visibleEntries.fetchedAt,
          read: visibleEntries.read,
          starred: visibleEntries.starred,
          subscriptionId: visibleEntries.subscriptionId,
          siteName: visibleEntries.siteName,
          feedTitle: feeds.title,
          rank: rankColumn,
        })
        .from(visibleEntries)
        .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
        .where(and(...conditions))
        .orderBy(desc(rankColumn), desc(visibleEntries.id))
        .limit(limit + 1);

      // Determine if there are more results
      const hasMore = queryResults.length > limit;
      const resultEntries = hasMore ? queryResults.slice(0, limit) : queryResults;

      // Format the output
      const items = resultEntries.map((row) => ({
        id: row.id,
        subscriptionId: row.subscriptionId,
        feedId: row.feedId,
        type: row.type,
        url: row.url,
        title: row.title,
        author: row.author,
        summary: row.summary,
        publishedAt: row.publishedAt,
        fetchedAt: row.fetchedAt,
        read: row.read,
        starred: row.starred,
        feedTitle: row.feedTitle,
        siteName: row.siteName,
      }));

      // Generate next cursor if there are more results
      // For search, cursor contains rank (as string) + ID
      let nextCursor: string | undefined;
      if (hasMore && resultEntries.length > 0) {
        const lastEntry = resultEntries[resultEntries.length - 1];
        nextCursor = encodeCursor(new Date(lastEntry.rank.toString()), lastEntry.id);
      }

      return { items, nextCursor };
    }),

  /**
   * Get a single entry by ID with full content.
   *
   * The entry is visible to a user only if they have a corresponding
   * row in the user_entries table for their user_id.
   *
   * @param id - The entry ID
   * @returns The full entry with content
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

      // Get the entry using visible_entries view
      // The view already enforces visibility and includes subscription_id
      const result = await ctx.db
        .select({
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
          subscriptionId: visibleEntries.subscriptionId,
          siteName: visibleEntries.siteName,
          feedTitle: feeds.title,
          feedUrl: feeds.url,
          fullContentOriginal: visibleEntries.fullContentOriginal,
          fullContentCleaned: visibleEntries.fullContentCleaned,
          fullContentFetchedAt: visibleEntries.fullContentFetchedAt,
          fullContentError: visibleEntries.fullContentError,
        })
        .from(visibleEntries)
        .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
        .where(and(eq(visibleEntries.id, input.id), eq(visibleEntries.userId, userId)))
        .limit(1);

      if (result.length === 0) {
        throw errors.entryNotFound();
      }

      const entry = result[0];

      return {
        entry: {
          id: entry.id,
          subscriptionId: entry.subscriptionId,
          feedId: entry.feedId,
          type: entry.type,
          url: entry.url,
          title: entry.title,
          author: entry.author,
          contentOriginal: entry.contentOriginal,
          contentCleaned: entry.contentCleaned,
          summary: entry.summary,
          publishedAt: entry.publishedAt,
          fetchedAt: entry.fetchedAt,
          read: entry.read,
          starred: entry.starred,
          feedTitle: entry.feedTitle,
          feedUrl: entry.feedUrl,
          siteName: entry.siteName,
          fullContentOriginal: entry.fullContentOriginal,
          fullContentCleaned: entry.fullContentCleaned,
          fullContentFetchedAt: entry.fullContentFetchedAt,
          fullContentError: entry.fullContentError,
        },
      };
    }),

  /**
   * Mark entries as read or unread (bulk operation).
   *
   * Only entries the user has access to (via user_entries) will be updated.
   * Returns entries with subscription context for client-side cache updates.
   *
   * @param ids - Array of entry IDs to mark
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
        ids: z
          .array(uuidSchema)
          .min(1, "At least one entry ID is required")
          .max(1000, "Maximum 1000 entries per request"),
        read: z.boolean(),
        changedAt: z.coerce.date().optional(),
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
            starred: z.boolean(), // For updating starred unread count
            type: feedTypeSchema, // For updating saved/email counts
          })
        ),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const changedAt = input.changedAt ?? new Date();

      // Conditional update: only apply if incoming timestamp is newer
      await ctx.db
        .update(userEntries)
        .set({
          read: input.read,
          readChangedAt: changedAt,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(userEntries.userId, userId),
            inArray(userEntries.entryId, input.ids),
            lt(userEntries.readChangedAt, changedAt)
          )
        );

      // Always return final state for all requested entries
      const entrySubscriptions = await ctx.db
        .select({
          id: visibleEntries.id,
          subscriptionId: visibleEntries.subscriptionId,
          starred: visibleEntries.starred,
          type: visibleEntries.type,
        })
        .from(visibleEntries)
        .where(and(eq(visibleEntries.userId, userId), inArray(visibleEntries.id, input.ids)));

      return {
        success: true,
        count: entrySubscriptions.length,
        entries: entrySubscriptions.map((e) => ({
          id: e.id,
          subscriptionId: e.subscriptionId,
          starred: e.starred,
          type: e.type,
        })),
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

      // Build conditions for the update
      // Note: We also require readChangedAt < changedAt for idempotency
      const conditions = [
        eq(userEntries.userId, userId),
        eq(userEntries.read, false),
        lt(userEntries.readChangedAt, changedAt),
      ];

      // Filter by subscriptionId
      if (input.subscriptionId) {
        const subFeedIds = await getSubscriptionFeedIds(ctx.db, input.subscriptionId, userId);
        if (subFeedIds === null) {
          return { count: 0 };
        }
        // Get entry IDs for these feeds
        const feedEntryIds = await ctx.db
          .select({ id: entries.id })
          .from(entries)
          .where(inArray(entries.feedId, subFeedIds));

        if (feedEntryIds.length === 0) {
          return { count: 0 };
        }

        conditions.push(
          inArray(
            userEntries.entryId,
            feedEntryIds.map((e) => e.id)
          )
        );
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

        // Get feed IDs for subscriptions with this tag using user_feeds view
        const taggedSubscriptions = await ctx.db
          .select({ feedIds: userFeeds.feedIds })
          .from(subscriptionTags)
          .innerJoin(userFeeds, eq(subscriptionTags.subscriptionId, userFeeds.id))
          .where(eq(subscriptionTags.tagId, input.tagId));

        if (taggedSubscriptions.length === 0) {
          return { count: 0 };
        }

        const taggedFeedIds = taggedSubscriptions.flatMap((s) => s.feedIds);

        // Get entry IDs for these feeds
        const taggedEntryIds = await ctx.db
          .select({ id: entries.id })
          .from(entries)
          .where(inArray(entries.feedId, taggedFeedIds));

        if (taggedEntryIds.length === 0) {
          return { count: 0 };
        }

        conditions.push(
          inArray(
            userEntries.entryId,
            taggedEntryIds.map((e) => e.id)
          )
        );
      }

      // If uncategorized is true, filter entries by feeds with no tags
      if (input.uncategorized) {
        // Get subscription IDs that have tags
        const taggedSubscriptionIds = await ctx.db
          .select({ subscriptionId: subscriptionTags.subscriptionId })
          .from(subscriptionTags);

        // Get feed IDs for subscriptions with no tags using user_feeds view
        let uncategorizedFeedIds: string[];
        if (taggedSubscriptionIds.length === 0) {
          // No tagged subscriptions, all active subscriptions are uncategorized
          const allSubscriptions = await ctx.db
            .select({ feedIds: userFeeds.feedIds })
            .from(userFeeds)
            .where(eq(userFeeds.userId, userId));

          uncategorizedFeedIds = allSubscriptions.flatMap((s) => s.feedIds);
        } else {
          // Get subscriptions that are not in the tagged list
          const uncategorizedSubscriptions = await ctx.db
            .select({ feedIds: userFeeds.feedIds })
            .from(userFeeds)
            .where(
              and(
                eq(userFeeds.userId, userId),
                notInArray(
                  userFeeds.id,
                  taggedSubscriptionIds.map((s) => s.subscriptionId)
                )
              )
            );

          uncategorizedFeedIds = uncategorizedSubscriptions.flatMap((s) => s.feedIds);
        }

        if (uncategorizedFeedIds.length === 0) {
          return { count: 0 };
        }

        // Get entry IDs for these feeds
        const uncategorizedEntryIds = await ctx.db
          .select({ id: entries.id })
          .from(entries)
          .where(inArray(entries.feedId, uncategorizedFeedIds));

        if (uncategorizedEntryIds.length === 0) {
          return { count: 0 };
        }

        conditions.push(
          inArray(
            userEntries.entryId,
            uncategorizedEntryIds.map((e) => e.id)
          )
        );
      }

      // If starredOnly is true, filter to only starred entries
      if (input.starredOnly) {
        conditions.push(eq(userEntries.starred, true));
      }

      // If type is provided, filter entries by feed type
      if (input.type) {
        // Get entry IDs from feeds of this type
        const typeEntryIds = await ctx.db
          .select({ id: entries.id })
          .from(entries)
          .innerJoin(feeds, eq(entries.feedId, feeds.id))
          .where(eq(feeds.type, input.type));

        if (typeEntryIds.length === 0) {
          return { count: 0 };
        }

        conditions.push(
          inArray(
            userEntries.entryId,
            typeEntryIds.map((e) => e.id)
          )
        );
      }

      // If before date is provided, filter entries by fetchedAt
      if (input.before) {
        // Get entry IDs fetched before the specified date
        const beforeEntryIds = await ctx.db
          .select({ id: entries.id })
          .from(entries)
          .where(lte(entries.fetchedAt, input.before));

        if (beforeEntryIds.length === 0) {
          return { count: 0 };
        }

        conditions.push(
          inArray(
            userEntries.entryId,
            beforeEntryIds.map((e) => e.id)
          )
        );
      }

      // Get count of entries to be marked as read
      const entriesToMark = await ctx.db
        .select({ entryId: userEntries.entryId })
        .from(userEntries)
        .where(and(...conditions));

      if (entriesToMark.length === 0) {
        return { count: 0 };
      }

      // Update all matching user_entries to read
      await ctx.db
        .update(userEntries)
        .set({
          read: true,
          readChangedAt: changedAt,
          updatedAt: new Date(),
        })
        .where(and(...conditions));

      return { count: entriesToMark.length };
    }),

  /**
   * Star an entry.
   *
   * The entry must be visible to the user (via user_entries).
   *
   * @param id - The entry ID to star
   * @returns The updated entry with current state
   */
  star: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/entries/{id}/star",
        tags: ["Entries"],
        summary: "Star entry",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
        changedAt: z.coerce.date().optional(),
      })
    )
    .output(starOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const entry = await updateEntryStarred(
        ctx,
        ctx.session.user.id,
        input.id,
        true,
        input.changedAt ?? new Date()
      );
      return { entry };
    }),

  /**
   * Unstar an entry.
   *
   * The entry must be visible to the user (via user_entries).
   *
   * @param id - The entry ID to unstar
   * @returns The updated entry with current state
   */
  unstar: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/entries/{id}/star",
        tags: ["Entries"],
        summary: "Unstar entry",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
        changedAt: z.coerce.date().optional(),
      })
    )
    .output(starOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const entry = await updateEntryStarred(
        ctx,
        ctx.session.user.id,
        input.id,
        false,
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
        total: z.number(),
        unread: z.number(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Use the shared countEntries service function
      return countEntries(ctx.db, ctx.session.user.id, {
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

      // First, verify the entry exists and user has access
      const existingEntry = await ctx.db
        .select({
          id: visibleEntries.id,
          feedId: visibleEntries.feedId,
          type: visibleEntries.type,
          url: visibleEntries.url,
          title: visibleEntries.title,
          author: visibleEntries.author,
          contentOriginal: visibleEntries.contentOriginal,
          contentCleaned: visibleEntries.contentCleaned,
          contentHash: visibleEntries.contentHash,
          summary: visibleEntries.summary,
          publishedAt: visibleEntries.publishedAt,
          fetchedAt: visibleEntries.fetchedAt,
          read: visibleEntries.read,
          starred: visibleEntries.starred,
          subscriptionId: visibleEntries.subscriptionId,
          siteName: visibleEntries.siteName,
          fullContentOriginal: visibleEntries.fullContentOriginal,
          fullContentCleaned: visibleEntries.fullContentCleaned,
          fullContentFetchedAt: visibleEntries.fullContentFetchedAt,
          fullContentError: visibleEntries.fullContentError,
          feedTitle: feeds.title,
          feedUrl: feeds.url,
        })
        .from(visibleEntries)
        .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
        .where(and(eq(visibleEntries.id, input.id), eq(visibleEntries.userId, userId)))
        .limit(1);

      if (existingEntry.length === 0) {
        throw errors.entryNotFound();
      }

      const entry = existingEntry[0];

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

      // Update entry with full content
      const now = new Date();
      await ctx.db
        .update(entries)
        .set({
          fullContentOriginal: result.contentOriginal ?? null,
          fullContentCleaned: result.contentCleaned ?? null,
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
