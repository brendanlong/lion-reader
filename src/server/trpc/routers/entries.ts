/**
 * Entries Router
 *
 * Handles entry listing and actions: list, get, mark read, star.
 * Implements visibility rules: users only see entries fetched after they subscribed.
 */

import { z } from "zod";
import { eq, and, isNull, desc, lt, inArray } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { entries, feeds, subscriptions, userEntryStates } from "@/server/db/schema";

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
   * Entries are visible to a user only if:
   * 1. The user is subscribed to the feed
   * 2. The entry was fetched_at >= the subscription's subscribed_at date
   *
   * @param feedId - Optional filter by feed ID
   * @param unreadOnly - Optional filter to show only unread entries
   * @param starredOnly - Optional filter to show only starred entries
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
        unreadOnly: z.boolean().optional(),
        starredOnly: z.boolean().optional(),
        cursor: cursorSchema,
        limit: limitSchema,
      })
    )
    .output(entriesListOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const limit = input.limit ?? DEFAULT_LIMIT;

      // Get the user's active subscriptions
      const userSubscriptions = await ctx.db
        .select({
          feedId: subscriptions.feedId,
          subscribedAt: subscriptions.subscribedAt,
        })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

      if (userSubscriptions.length === 0) {
        return { items: [], nextCursor: undefined };
      }

      // If filtering by feedId, verify user is subscribed to it
      if (input.feedId) {
        const isSubscribed = userSubscriptions.some((sub) => sub.feedId === input.feedId);
        if (!isSubscribed) {
          // User is not subscribed to this feed, return empty result
          return { items: [], nextCursor: undefined };
        }
      }

      // Build subscription map for visibility filtering
      const subscriptionMap = new Map(
        userSubscriptions.map((sub) => [sub.feedId, sub.subscribedAt])
      );

      // Get the feed IDs to query
      const feedIds = input.feedId ? [input.feedId] : userSubscriptions.map((sub) => sub.feedId);

      // Build the base query conditions
      const conditions = [inArray(entries.feedId, feedIds)];

      // Add cursor condition if present
      if (input.cursor) {
        const cursorEntryId = decodeCursor(input.cursor);
        conditions.push(lt(entries.id, cursorEntryId));
      }

      // Query entries with user state
      // We fetch one extra to determine if there are more results
      const queryResults = await ctx.db
        .select({
          entry: entries,
          feed: feeds,
          userState: userEntryStates,
        })
        .from(entries)
        .innerJoin(feeds, eq(entries.feedId, feeds.id))
        .leftJoin(
          userEntryStates,
          and(eq(userEntryStates.entryId, entries.id), eq(userEntryStates.userId, userId))
        )
        .where(and(...conditions))
        .orderBy(desc(entries.id))
        .limit(limit + 1);

      // Filter results by visibility (entry.fetchedAt >= subscription.subscribedAt)
      // and by read/starred status if requested
      const visibleEntries = queryResults.filter(({ entry }) => {
        const subscribedAt = subscriptionMap.get(entry.feedId);
        if (!subscribedAt) return false;
        return entry.fetchedAt >= subscribedAt;
      });

      // Apply unreadOnly filter
      let filteredEntries = visibleEntries;
      if (input.unreadOnly) {
        filteredEntries = filteredEntries.filter(({ userState }) => !userState?.read);
      }

      // Apply starredOnly filter
      if (input.starredOnly) {
        filteredEntries = filteredEntries.filter(({ userState }) => userState?.starred === true);
      }

      // Determine if there are more results
      const hasMore = filteredEntries.length > limit;
      const resultEntries = hasMore ? filteredEntries.slice(0, limit) : filteredEntries;

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
        read: userState?.read ?? false,
        starred: userState?.starred ?? false,
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
   * The entry is visible to a user only if:
   * 1. The user is subscribed to the feed
   * 2. The entry was fetched_at >= the subscription's subscribed_at date
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
      const result = await ctx.db
        .select({
          entry: entries,
          feed: feeds,
          userState: userEntryStates,
        })
        .from(entries)
        .innerJoin(feeds, eq(entries.feedId, feeds.id))
        .leftJoin(
          userEntryStates,
          and(eq(userEntryStates.entryId, entries.id), eq(userEntryStates.userId, userId))
        )
        .where(eq(entries.id, input.id))
        .limit(1);

      if (result.length === 0) {
        throw errors.entryNotFound();
      }

      const { entry, feed, userState } = result[0];

      // Check if user is subscribed to this feed
      const subscription = await ctx.db
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.userId, userId),
            eq(subscriptions.feedId, entry.feedId),
            isNull(subscriptions.unsubscribedAt)
          )
        )
        .limit(1);

      if (subscription.length === 0) {
        // User is not subscribed to this feed
        throw errors.entryNotFound();
      }

      // Check visibility: entry.fetchedAt >= subscription.subscribedAt
      if (entry.fetchedAt < subscription[0].subscribedAt) {
        // Entry was fetched before user subscribed
        throw errors.entryNotFound();
      }

      return {
        entry: {
          id: entry.id,
          feedId: entry.feedId,
          url: entry.url,
          title: entry.title,
          author: entry.author,
          contentOriginal: entry.contentOriginal,
          summary: entry.summary,
          publishedAt: entry.publishedAt,
          fetchedAt: entry.fetchedAt,
          read: userState?.read ?? false,
          starred: userState?.starred ?? false,
          feedTitle: feed.title,
          feedUrl: feed.url,
        },
      };
    }),
});
