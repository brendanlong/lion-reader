/**
 * Entries Router
 *
 * Handles entry listing and actions: list, get, mark read, star.
 * Visibility is determined by the user_entries table: users only see entries
 * that have a corresponding row in user_entries for their user_id.
 */

import { z } from "zod";
import { eq, and, isNull, desc, asc, lt, gt, lte, inArray } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import {
  entries,
  feeds,
  subscriptions,
  userEntries,
  subscriptionTags,
  tags,
} from "@/server/db/schema";

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

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Lightweight entry output schema for list view (no full content).
 */
const entryListItemSchema = z.object({
  id: z.string(),
  feedId: z.string(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  summary: z.string().nullable(),
  publishedAt: z.date().nullable(),
  fetchedAt: z.date(),
  read: z.boolean(),
  starred: z.boolean(),
  feedTitle: z.string().nullable(),
});

/**
 * Full entry output schema for single entry view (includes content).
 */
const entryFullSchema = z.object({
  id: z.string(),
  feedId: z.string(),
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
});

/**
 * Paginated entries list output schema.
 */
const entriesListOutputSchema = z.object({
  items: z.array(entryListItemSchema),
  nextCursor: z.string().optional(),
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Decodes a cursor to get the entry ID.
 * Cursor is base64-encoded entry ID.
 *
 * @param cursor - The cursor string
 * @returns The decoded entry ID
 */
function decodeCursor(cursor: string): string {
  try {
    return Buffer.from(cursor, "base64").toString("utf8");
  } catch {
    throw errors.validation("Invalid cursor format");
  }
}

/**
 * Encodes an entry ID as a cursor.
 *
 * @param entryId - The entry ID
 * @returns The encoded cursor
 */
function encodeCursor(entryId: string): string {
  return Buffer.from(entryId, "utf8").toString("base64");
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
   * @param feedId - Optional filter by feed ID
   * @param tagId - Optional filter by tag ID (entries from feeds with this tag)
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
        path: "/v1/entries",
        tags: ["Entries"],
        summary: "List entries",
      },
    })
    .input(
      z.object({
        feedId: uuidSchema.optional(),
        tagId: uuidSchema.optional(),
        unreadOnly: z.boolean().optional(),
        starredOnly: z.boolean().optional(),
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

      // Build the base query conditions
      // Visibility is enforced by inner join with user_entries
      const conditions = [eq(userEntries.userId, userId)];

      // Filter by feedId if specified
      if (input.feedId) {
        conditions.push(eq(entries.feedId, input.feedId));
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

        // Get subscriptions with this tag
        const taggedSubscriptions = await ctx.db
          .select({ feedId: subscriptions.feedId })
          .from(subscriptionTags)
          .innerJoin(subscriptions, eq(subscriptionTags.subscriptionId, subscriptions.id))
          .where(
            and(eq(subscriptionTags.tagId, input.tagId), isNull(subscriptions.unsubscribedAt))
          );

        if (taggedSubscriptions.length === 0) {
          // No subscriptions with this tag
          return { items: [], nextCursor: undefined };
        }

        const taggedFeedIds = taggedSubscriptions.map((s) => s.feedId);
        conditions.push(inArray(entries.feedId, taggedFeedIds));
      }

      // Apply unreadOnly filter
      if (input.unreadOnly) {
        conditions.push(eq(userEntries.read, false));
      }

      // Apply starredOnly filter
      if (input.starredOnly) {
        conditions.push(eq(userEntries.starred, true));
      }

      // Add cursor condition if present
      // For newest-first (desc), we want entries with ID < cursor
      // For oldest-first (asc), we want entries with ID > cursor
      if (input.cursor) {
        const cursorEntryId = decodeCursor(input.cursor);
        if (sortOrder === "newest") {
          conditions.push(lt(entries.id, cursorEntryId));
        } else {
          conditions.push(gt(entries.id, cursorEntryId));
        }
      }

      // Query entries with user state
      // Inner join with user_entries enforces visibility
      // We fetch one extra to determine if there are more results
      const orderByClause = sortOrder === "newest" ? desc(entries.id) : asc(entries.id);
      const queryResults = await ctx.db
        .select({
          entry: entries,
          feed: feeds,
          userState: userEntries,
        })
        .from(entries)
        .innerJoin(feeds, eq(entries.feedId, feeds.id))
        .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
        .where(and(...conditions))
        .orderBy(orderByClause)
        .limit(limit + 1);

      // Determine if there are more results
      const hasMore = queryResults.length > limit;
      const resultEntries = hasMore ? queryResults.slice(0, limit) : queryResults;

      // Format the output
      const items = resultEntries.map(({ entry, feed, userState }) => ({
        id: entry.id,
        feedId: entry.feedId,
        url: entry.url,
        title: entry.title,
        author: entry.author,
        summary: entry.summary,
        publishedAt: entry.publishedAt,
        fetchedAt: entry.fetchedAt,
        read: userState.read,
        starred: userState.starred,
        feedTitle: feed.title,
      }));

      // Generate next cursor if there are more results
      const nextCursor =
        hasMore && resultEntries.length > 0
          ? encodeCursor(resultEntries[resultEntries.length - 1].entry.id)
          : undefined;

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
        path: "/v1/entries/{id}",
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

      // Get the entry with feed and user state
      // Inner join with user_entries enforces visibility
      const result = await ctx.db
        .select({
          entry: entries,
          feed: feeds,
          userState: userEntries,
        })
        .from(entries)
        .innerJoin(feeds, eq(entries.feedId, feeds.id))
        .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
        .where(and(eq(entries.id, input.id), eq(userEntries.userId, userId)))
        .limit(1);

      if (result.length === 0) {
        throw errors.entryNotFound();
      }

      const { entry, feed, userState } = result[0];

      return {
        entry: {
          id: entry.id,
          feedId: entry.feedId,
          url: entry.url,
          title: entry.title,
          author: entry.author,
          contentOriginal: entry.contentOriginal,
          contentCleaned: entry.contentCleaned,
          summary: entry.summary,
          publishedAt: entry.publishedAt,
          fetchedAt: entry.fetchedAt,
          read: userState.read,
          starred: userState.starred,
          feedTitle: feed.title,
          feedUrl: feed.url,
        },
      };
    }),

  /**
   * Mark entries as read or unread (bulk operation).
   *
   * Only entries the user has access to (via user_entries) will be updated.
   *
   * @param ids - Array of entry IDs to mark
   * @param read - Whether to mark as read (true) or unread (false)
   * @returns Empty object on success
   */
  markRead: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/entries/mark-read",
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
      })
    )
    .output(z.object({}))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const now = new Date();

      // Update read status on user_entries rows that exist for this user
      // Visibility is enforced by the user_entries table - only rows that exist can be updated
      await ctx.db
        .update(userEntries)
        .set({
          read: input.read,
          readAt: input.read ? now : null,
        })
        .where(and(eq(userEntries.userId, userId), inArray(userEntries.entryId, input.ids)));

      return {};
    }),

  /**
   * Mark all entries as read with optional filters.
   *
   * @param feedId - Optional filter to mark only entries from a specific feed
   * @param before - Optional filter to mark only entries fetched before this date
   * @returns The count of entries marked as read
   */
  markAllRead: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/entries/mark-all-read",
        tags: ["Entries"],
        summary: "Mark all entries read",
      },
    })
    .input(
      z.object({
        feedId: uuidSchema.optional(),
        before: z.coerce.date().optional(),
      })
    )
    .output(z.object({ count: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const now = new Date();

      // Build conditions for the update
      const conditions = [eq(userEntries.userId, userId), eq(userEntries.read, false)];

      // If feedId is provided, filter entries by feed
      if (input.feedId) {
        // Get entry IDs for this feed
        const feedEntryIds = await ctx.db
          .select({ id: entries.id })
          .from(entries)
          .where(eq(entries.feedId, input.feedId));

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
          readAt: now,
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
   * @returns Empty object on success
   */
  star: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/entries/{id}/star",
        tags: ["Entries"],
        summary: "Star entry",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(z.object({}))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const now = new Date();

      // Check if entry is visible to user (via user_entries)
      const userEntry = await ctx.db
        .select()
        .from(userEntries)
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, input.id)))
        .limit(1);

      if (userEntry.length === 0) {
        throw errors.entryNotFound();
      }

      // Update the starred status
      await ctx.db
        .update(userEntries)
        .set({
          starred: true,
          starredAt: now,
        })
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, input.id)));

      return {};
    }),

  /**
   * Unstar an entry.
   *
   * The entry must be visible to the user (via user_entries).
   *
   * @param id - The entry ID to unstar
   * @returns Empty object on success
   */
  unstar: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/v1/entries/{id}/star",
        tags: ["Entries"],
        summary: "Unstar entry",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(z.object({}))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Check if entry is visible to user (via user_entries)
      const userEntry = await ctx.db
        .select()
        .from(userEntries)
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, input.id)))
        .limit(1);

      if (userEntry.length === 0) {
        throw errors.entryNotFound();
      }

      // Update the starred status
      await ctx.db
        .update(userEntries)
        .set({
          starred: false,
          starredAt: null,
        })
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, input.id)));

      return {};
    }),
});
