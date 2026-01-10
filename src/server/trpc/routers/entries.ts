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
import { eq, and, or, isNull, desc, asc, lte, inArray, notInArray, sql } from "drizzle-orm";

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
  feedId: z.string(),
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
  feedId: z.string(),
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
 * Used by normy for automatic cache normalization.
 */
const entryMutationResultSchema = z.object({
  id: z.string(),
  read: z.boolean(),
  starred: z.boolean(),
});

/**
 * Output schema for markRead mutation.
 */
const markReadOutputSchema = z.object({
  entries: z.array(entryMutationResultSchema),
});

/**
 * Output schema for star/unstar mutations.
 * Returns single entry for normy cache normalization.
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
        path: "/entries",
        tags: ["Entries"],
        summary: "List entries",
      },
    })
    .input(
      z.object({
        feedId: uuidSchema.optional(),
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

      // Build the base query conditions
      // Visibility is enforced by inner join with user_entries
      const conditions = [eq(userEntries.userId, userId)];

      // Entry must be:
      // 1. From active subscription (current feed or previous feeds from redirects), OR
      // 2. Starred, OR
      // 3. From user's saved feed (type='saved' and feed.userId = userId)
      // Note: feed_ids is a generated column that combines feedId with previousFeedIds
      const activeSubscriptionFeedIds = ctx.db
        .select({ feedId: sql<string>`unnest(${subscriptions.feedIds})`.as("feed_id") })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

      const savedFeedIds = ctx.db
        .select({ id: feeds.id })
        .from(feeds)
        .where(and(eq(feeds.type, "saved"), eq(feeds.userId, userId)));

      conditions.push(
        or(
          inArray(entries.feedId, activeSubscriptionFeedIds),
          eq(userEntries.starred, true),
          inArray(entries.feedId, savedFeedIds)
        )!
      );

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

        // Get feed IDs for subscriptions with this tag (including previous feeds from redirects)
        // Include starred entries even if no subscriptions have this tag
        const taggedFeedIds = ctx.db
          .select({ feedId: sql<string>`unnest(${subscriptions.feedIds})`.as("feed_id") })
          .from(subscriptionTags)
          .innerJoin(subscriptions, eq(subscriptionTags.subscriptionId, subscriptions.id))
          .where(
            and(eq(subscriptionTags.tagId, input.tagId), isNull(subscriptions.unsubscribedAt))
          );
        conditions.push(or(inArray(entries.feedId, taggedFeedIds), eq(userEntries.starred, true))!);
      }

      // Filter by uncategorized if specified
      if (input.uncategorized) {
        // Get subscription IDs that have tags
        const taggedSubscriptionIds = ctx.db
          .select({ subscriptionId: subscriptionTags.subscriptionId })
          .from(subscriptionTags);

        // Get feed IDs for subscriptions with no tags (including previous feeds from redirects)
        const uncategorizedFeedIds = ctx.db
          .select({ feedId: sql<string>`unnest(${subscriptions.feedIds})`.as("feed_id") })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.userId, userId),
              isNull(subscriptions.unsubscribedAt),
              notInArray(subscriptions.id, taggedSubscriptionIds)
            )
          );

        conditions.push(
          or(inArray(entries.feedId, uncategorizedFeedIds), eq(userEntries.starred, true))!
        );
      }

      // Apply unreadOnly filter
      if (input.unreadOnly) {
        conditions.push(eq(userEntries.read, false));
      }

      // Apply starredOnly filter
      if (input.starredOnly) {
        conditions.push(eq(userEntries.starred, true));
      }

      // Apply type filter if specified
      if (input.type) {
        conditions.push(eq(entries.type, input.type));
      }

      // Apply excludeTypes filter if specified
      if (input.excludeTypes && input.excludeTypes.length > 0) {
        conditions.push(notInArray(entries.type, input.excludeTypes));
      }

      // Apply spam filter: exclude spam entries unless user has showSpam enabled
      // Filter: entries shown if (NOT is_spam) OR (user.showSpam is true)
      const showSpam = ctx.session.user.showSpam;
      if (!showSpam) {
        conditions.push(eq(entries.isSpam, false));
      }

      // Sort by publishedAt, falling back to fetchedAt if null
      // Use entry.id as tiebreaker for stable ordering
      const sortColumn = sql`COALESCE(${entries.publishedAt}, ${entries.fetchedAt})`;

      // Add cursor condition if present
      // Uses compound comparison: (sortColumn, id) for stable pagination
      // For newest-first (desc), we want entries with (date, id) < cursor
      // For oldest-first (asc), we want entries with (date, id) > cursor
      if (input.cursor) {
        const { ts, id } = decodeCursor(input.cursor);
        const cursorTs = new Date(ts);
        if (sortOrder === "newest") {
          // Entries older than cursor, or same timestamp with smaller ID
          conditions.push(
            sql`(${sortColumn} < ${cursorTs} OR (${sortColumn} = ${cursorTs} AND ${entries.id} < ${id}))`
          );
        } else {
          // Entries newer than cursor, or same timestamp with larger ID
          conditions.push(
            sql`(${sortColumn} > ${cursorTs} OR (${sortColumn} = ${cursorTs} AND ${entries.id} > ${id}))`
          );
        }
      }

      // Query entries with user state
      // Inner join with user_entries enforces visibility
      // We fetch one extra to determine if there are more results
      const orderByClause =
        sortOrder === "newest"
          ? [desc(sortColumn), desc(entries.id)]
          : [asc(sortColumn), asc(entries.id)];
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
        .orderBy(...orderByClause)
        .limit(limit + 1);

      // Determine if there are more results
      const hasMore = queryResults.length > limit;
      const resultEntries = hasMore ? queryResults.slice(0, limit) : queryResults;

      // Format the output
      const items = resultEntries.map(({ entry, feed, userState }) => ({
        id: entry.id,
        feedId: entry.feedId,
        type: entry.type,
        url: entry.url,
        title: entry.title,
        author: entry.author,
        summary: entry.summary,
        publishedAt: entry.publishedAt,
        fetchedAt: entry.fetchedAt,
        read: userState.read,
        starred: userState.starred,
        feedTitle: feed.title,
        siteName: entry.siteName,
      }));

      // Generate next cursor if there are more results
      let nextCursor: string | undefined;
      if (hasMore && resultEntries.length > 0) {
        const lastEntry = resultEntries[resultEntries.length - 1].entry;
        const lastTs = lastEntry.publishedAt ?? lastEntry.fetchedAt;
        nextCursor = encodeCursor(lastTs, lastEntry.id);
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

      // Get the entry with feed and user state
      // Permission check is in WHERE: must be starred OR have active subscription OR be from saved feed
      const result = await ctx.db
        .select({
          entry: entries,
          feed: feeds,
          userState: userEntries,
        })
        .from(entries)
        .innerJoin(feeds, eq(entries.feedId, feeds.id))
        .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
        .leftJoin(
          subscriptions,
          and(
            sql`${entries.feedId} = ANY(${subscriptions.feedIds})`,
            eq(subscriptions.userId, userId),
            isNull(subscriptions.unsubscribedAt)
          )
        )
        .where(
          and(
            eq(entries.id, input.id),
            eq(userEntries.userId, userId),
            // Permission: starred OR has active subscription OR is user's saved feed
            or(
              eq(userEntries.starred, true),
              sql`${subscriptions.id} IS NOT NULL`,
              and(eq(feeds.type, "saved"), eq(feeds.userId, userId))
            )
          )
        )
        .limit(1);

      if (result.length === 0) {
        throw errors.entryNotFound();
      }

      const { entry, feed, userState } = result[0];

      return {
        entry: {
          id: entry.id,
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
          read: userState.read,
          starred: userState.starred,
          feedTitle: feed.title,
          feedUrl: feed.url,
          siteName: entry.siteName,
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
   * @returns The updated entries with their current state
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
      })
    )
    .output(markReadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Update read status on user_entries rows that exist for this user
      // Visibility is enforced by the user_entries table - only rows that exist can be updated
      await ctx.db
        .update(userEntries)
        .set({
          read: input.read,
          updatedAt: new Date(),
        })
        .where(and(eq(userEntries.userId, userId), inArray(userEntries.entryId, input.ids)));

      // Fetch the updated entries to return their current state
      // This enables normy to automatically update cached queries
      const updatedEntries = await ctx.db
        .select({
          id: userEntries.entryId,
          read: userEntries.read,
          starred: userEntries.starred,
        })
        .from(userEntries)
        .where(and(eq(userEntries.userId, userId), inArray(userEntries.entryId, input.ids)));

      return { entries: updatedEntries };
    }),

  /**
   * Mark all entries as read with optional filters.
   *
   * @param feedId - Optional filter to mark only entries from a specific feed
   * @param tagId - Optional filter to mark only entries from feeds with this tag
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
        feedId: uuidSchema.optional(),
        tagId: uuidSchema.optional(),
        uncategorized: z.boolean().optional(),
        starredOnly: z.boolean().optional(),
        before: z.coerce.date().optional(),
      })
    )
    .output(z.object({ count: z.number() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

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

        // Get feed IDs for subscriptions with this tag (including previous feeds from redirects)
        const taggedSubscriptions = await ctx.db
          .select({ feedIds: subscriptions.feedIds })
          .from(subscriptionTags)
          .innerJoin(subscriptions, eq(subscriptionTags.subscriptionId, subscriptions.id))
          .where(
            and(eq(subscriptionTags.tagId, input.tagId), isNull(subscriptions.unsubscribedAt))
          );

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

        // Get feed IDs for subscriptions with no tags (including previous feeds from redirects)
        let uncategorizedFeedIds: string[];
        if (taggedSubscriptionIds.length === 0) {
          // No tagged subscriptions, all active subscriptions are uncategorized
          const allSubscriptions = await ctx.db
            .select({ feedIds: subscriptions.feedIds })
            .from(subscriptions)
            .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

          uncategorizedFeedIds = allSubscriptions.flatMap((s) => s.feedIds);
        } else {
          // Get subscriptions that are not in the tagged list
          const uncategorizedSubscriptions = await ctx.db
            .select({ feedIds: subscriptions.feedIds })
            .from(subscriptions)
            .where(
              and(
                eq(subscriptions.userId, userId),
                isNull(subscriptions.unsubscribedAt),
                notInArray(
                  subscriptions.id,
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
      })
    )
    .output(starOutputSchema)
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
          starred: true,
          updatedAt: new Date(),
        })
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, input.id)));

      // Fetch the updated entry to return its current state
      // This enables normy to automatically update cached queries
      const updatedEntry = await ctx.db
        .select({
          id: userEntries.entryId,
          read: userEntries.read,
          starred: userEntries.starred,
        })
        .from(userEntries)
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, input.id)))
        .limit(1);

      return { entry: updatedEntry[0] };
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
      })
    )
    .output(starOutputSchema)
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
          updatedAt: new Date(),
        })
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, input.id)));

      // Fetch the updated entry to return its current state
      // This enables normy to automatically update cached queries
      const updatedEntry = await ctx.db
        .select({
          id: userEntries.entryId,
          read: userEntries.read,
          starred: userEntries.starred,
        })
        .from(userEntries)
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, input.id)))
        .limit(1);

      return { entry: updatedEntry[0] };
    }),

  /**
   * Get count of starred entries.
   *
   * @returns Total and unread counts for starred entries
   */
  starredCount: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/entries/starred/count",
        tags: ["Entries"],
        summary: "Get starred entries count",
      },
    })
    .input(z.object({}).optional())
    .output(
      z.object({
        total: z.number(),
        unread: z.number(),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      // Get total and unread starred counts in a single query using conditional aggregation
      const result = await ctx.db
        .select({
          total: sql<number>`count(*)::int`,
          unread: sql<number>`count(*) FILTER (WHERE ${userEntries.read} = false)::int`,
        })
        .from(userEntries)
        .where(and(eq(userEntries.userId, userId), eq(userEntries.starred, true)));

      return {
        total: result[0]?.total ?? 0,
        unread: result[0]?.unread ?? 0,
      };
    }),

  /**
   * Get count of entries with optional filters.
   *
   * Entries are visible to a user only if they have a corresponding
   * row in the user_entries table for their user_id.
   *
   * @param feedId - Optional filter by feed ID
   * @param tagId - Optional filter by tag ID (entries from feeds with this tag)
   * @param type - Optional filter by entry type
   * @param excludeTypes - Optional types to exclude
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
          feedId: uuidSchema.optional(),
          tagId: uuidSchema.optional(),
          uncategorized: booleanQueryParam,
          type: feedTypeSchema.optional(),
          excludeTypes: z.array(feedTypeSchema).optional(),
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
      const userId = ctx.session.user.id;

      // Build the base query conditions
      // Visibility is enforced by inner join with user_entries
      const conditions = [eq(userEntries.userId, userId)];

      // Entry must be:
      // 1. From active subscription (current feed or previous feeds from redirects), OR
      // 2. Starred, OR
      // 3. From user's saved feed (type='saved' and feed.userId = userId)
      // Note: feed_ids is a generated column that combines feedId with previousFeedIds
      const activeSubscriptionFeedIds = ctx.db
        .select({ feedId: sql<string>`unnest(${subscriptions.feedIds})`.as("feed_id") })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

      const savedFeedIds = ctx.db
        .select({ id: feeds.id })
        .from(feeds)
        .where(and(eq(feeds.type, "saved"), eq(feeds.userId, userId)));

      conditions.push(
        or(
          inArray(entries.feedId, activeSubscriptionFeedIds),
          eq(userEntries.starred, true),
          inArray(entries.feedId, savedFeedIds)
        )!
      );

      // Filter by feedId if specified
      if (input?.feedId) {
        conditions.push(eq(entries.feedId, input.feedId));
      }

      // Filter by tagId if specified
      if (input?.tagId) {
        // First verify the tag belongs to the user
        const tagExists = await ctx.db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.id, input.tagId), eq(tags.userId, userId)))
          .limit(1);

        if (tagExists.length === 0) {
          // Tag not found or doesn't belong to user, return zero counts
          return { total: 0, unread: 0 };
        }

        // Get feed IDs for subscriptions with this tag (including previous feeds from redirects)
        // Include starred entries even if no subscriptions have this tag
        const taggedFeedIds = ctx.db
          .select({ feedId: sql<string>`unnest(${subscriptions.feedIds})`.as("feed_id") })
          .from(subscriptionTags)
          .innerJoin(subscriptions, eq(subscriptionTags.subscriptionId, subscriptions.id))
          .where(
            and(eq(subscriptionTags.tagId, input.tagId), isNull(subscriptions.unsubscribedAt))
          );
        conditions.push(or(inArray(entries.feedId, taggedFeedIds), eq(userEntries.starred, true))!);
      }

      // Filter by uncategorized if specified
      if (input?.uncategorized) {
        // Get subscription IDs that have tags
        const taggedSubscriptionIds = ctx.db
          .select({ subscriptionId: subscriptionTags.subscriptionId })
          .from(subscriptionTags);

        // Get feed IDs for subscriptions with no tags (including previous feeds from redirects)
        const uncategorizedFeedIds = ctx.db
          .select({ feedId: sql<string>`unnest(${subscriptions.feedIds})`.as("feed_id") })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.userId, userId),
              isNull(subscriptions.unsubscribedAt),
              notInArray(subscriptions.id, taggedSubscriptionIds)
            )
          );

        conditions.push(
          or(inArray(entries.feedId, uncategorizedFeedIds), eq(userEntries.starred, true))!
        );
      }

      // Apply type filter if specified
      if (input?.type) {
        conditions.push(eq(entries.type, input.type));
      }

      // Apply excludeTypes filter if specified
      if (input?.excludeTypes && input.excludeTypes.length > 0) {
        conditions.push(notInArray(entries.type, input.excludeTypes));
      }

      // Apply spam filter: exclude spam entries unless user has showSpam enabled
      const showSpam = ctx.session.user.showSpam;
      if (!showSpam) {
        conditions.push(eq(entries.isSpam, false));
      }

      // Get total and unread counts in a single query using conditional aggregation
      const result = await ctx.db
        .select({
          total: sql<number>`count(*)::int`,
          unread: sql<number>`count(*) FILTER (WHERE ${userEntries.read} = false)::int`,
        })
        .from(entries)
        .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
        .where(and(...conditions));

      return {
        total: result[0]?.total ?? 0,
        unread: result[0]?.unread ?? 0,
      };
    }),
});
