/**
 * Entries Router
 *
 * Handles entry listing and actions: list, get, mark read, star.
 * Implements visibility rules: users only see entries fetched after they subscribed.
 */

import { z } from "zod";
import { eq, and, isNull, desc, lt, lte, inArray } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import {
  entries,
  feeds,
  subscriptions,
  userEntryStates,
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
   * Entries are visible to a user only if:
   * 1. The user is subscribed to the feed
   * 2. The entry was fetched_at >= the subscription's subscribed_at date
   *
   * @param feedId - Optional filter by feed ID
   * @param tagId - Optional filter by tag ID (entries from feeds with this tag)
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
        tagId: uuidSchema.optional(),
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
      const subscriptionQuery = ctx.db
        .select({
          id: subscriptions.id,
          feedId: subscriptions.feedId,
          subscribedAt: subscriptions.subscribedAt,
        })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

      const userSubscriptions = await subscriptionQuery;

      if (userSubscriptions.length === 0) {
        return { items: [], nextCursor: undefined };
      }

      // If filtering by tagId, get subscriptions with that tag
      let filteredSubscriptions = userSubscriptions;
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
        const taggedSubscriptionIds = await ctx.db
          .select({ subscriptionId: subscriptionTags.subscriptionId })
          .from(subscriptionTags)
          .where(eq(subscriptionTags.tagId, input.tagId));

        const taggedIdSet = new Set(taggedSubscriptionIds.map((s) => s.subscriptionId));
        filteredSubscriptions = userSubscriptions.filter((sub) => taggedIdSet.has(sub.id));

        if (filteredSubscriptions.length === 0) {
          // No subscriptions with this tag
          return { items: [], nextCursor: undefined };
        }
      }

      // If filtering by feedId, verify user is subscribed to it
      if (input.feedId) {
        const isSubscribed = filteredSubscriptions.some((sub) => sub.feedId === input.feedId);
        if (!isSubscribed) {
          // User is not subscribed to this feed (or feed doesn't have the tag), return empty result
          return { items: [], nextCursor: undefined };
        }
      }

      // Build subscription map for visibility filtering
      const subscriptionMap = new Map(
        filteredSubscriptions.map((sub) => [sub.feedId, sub.subscribedAt])
      );

      // Get the feed IDs to query
      const feedIds = input.feedId
        ? [input.feedId]
        : filteredSubscriptions.map((sub) => sub.feedId);

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
          contentCleaned: entry.contentCleaned,
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

  /**
   * Mark entries as read or unread (bulk operation).
   *
   * Only entries the user has access to (subscribed feeds, visibility rules) will be updated.
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

      // Get the user's active subscriptions for visibility check
      const userSubscriptions = await ctx.db
        .select({
          feedId: subscriptions.feedId,
          subscribedAt: subscriptions.subscribedAt,
        })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

      if (userSubscriptions.length === 0) {
        // No subscriptions, no entries to mark
        return {};
      }

      // Build subscription map for visibility filtering
      const subscriptionMap = new Map(
        userSubscriptions.map((sub) => [sub.feedId, sub.subscribedAt])
      );

      const subscribedFeedIds = userSubscriptions.map((sub) => sub.feedId);

      // Get the entries that exist and belong to subscribed feeds
      const existingEntries = await ctx.db
        .select({
          id: entries.id,
          feedId: entries.feedId,
          fetchedAt: entries.fetchedAt,
        })
        .from(entries)
        .where(and(inArray(entries.id, input.ids), inArray(entries.feedId, subscribedFeedIds)));

      // Filter by visibility (entry.fetchedAt >= subscription.subscribedAt)
      const visibleEntryIds = existingEntries
        .filter((entry) => {
          const subscribedAt = subscriptionMap.get(entry.feedId);
          return subscribedAt && entry.fetchedAt >= subscribedAt;
        })
        .map((entry) => entry.id);

      if (visibleEntryIds.length === 0) {
        return {};
      }

      // Upsert user entry states for each entry
      for (const entryId of visibleEntryIds) {
        await ctx.db
          .insert(userEntryStates)
          .values({
            userId,
            entryId,
            read: input.read,
            readAt: input.read ? now : null,
          })
          .onConflictDoUpdate({
            target: [userEntryStates.userId, userEntryStates.entryId],
            set: {
              read: input.read,
              readAt: input.read ? now : null,
            },
          });
      }

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

      // Get the user's active subscriptions
      const userSubscriptions = await ctx.db
        .select({
          feedId: subscriptions.feedId,
          subscribedAt: subscriptions.subscribedAt,
        })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

      if (userSubscriptions.length === 0) {
        return { count: 0 };
      }

      // If feedId is provided, verify user is subscribed to it
      if (input.feedId) {
        const isSubscribed = userSubscriptions.some((sub) => sub.feedId === input.feedId);
        if (!isSubscribed) {
          return { count: 0 };
        }
      }

      // Build subscription map for visibility filtering
      const subscriptionMap = new Map(
        userSubscriptions.map((sub) => [sub.feedId, sub.subscribedAt])
      );

      // Get the feed IDs to query
      const feedIds = input.feedId ? [input.feedId] : userSubscriptions.map((sub) => sub.feedId);

      // Build query conditions
      const conditions = [inArray(entries.feedId, feedIds)];

      // Add before date filter if provided
      if (input.before) {
        conditions.push(lte(entries.fetchedAt, input.before));
      }

      // Get all entries matching the conditions
      const matchingEntries = await ctx.db
        .select({
          id: entries.id,
          feedId: entries.feedId,
          fetchedAt: entries.fetchedAt,
        })
        .from(entries)
        .where(and(...conditions));

      // Filter by visibility (entry.fetchedAt >= subscription.subscribedAt)
      const visibleEntryIds = matchingEntries
        .filter((entry) => {
          const subscribedAt = subscriptionMap.get(entry.feedId);
          return subscribedAt && entry.fetchedAt >= subscribedAt;
        })
        .map((entry) => entry.id);

      if (visibleEntryIds.length === 0) {
        return { count: 0 };
      }

      // Get entries that are not already marked as read
      const existingStates = await ctx.db
        .select({
          entryId: userEntryStates.entryId,
          read: userEntryStates.read,
        })
        .from(userEntryStates)
        .where(
          and(eq(userEntryStates.userId, userId), inArray(userEntryStates.entryId, visibleEntryIds))
        );

      const alreadyReadEntryIds = new Set(
        existingStates.filter((state) => state.read).map((state) => state.entryId)
      );

      // Filter to only entries that are not already read
      const entriesToMark = visibleEntryIds.filter((id) => !alreadyReadEntryIds.has(id));

      if (entriesToMark.length === 0) {
        return { count: 0 };
      }

      // Upsert user entry states for each entry
      for (const entryId of entriesToMark) {
        await ctx.db
          .insert(userEntryStates)
          .values({
            userId,
            entryId,
            read: true,
            readAt: now,
          })
          .onConflictDoUpdate({
            target: [userEntryStates.userId, userEntryStates.entryId],
            set: {
              read: true,
              readAt: now,
            },
          });
      }

      return { count: entriesToMark.length };
    }),

  /**
   * Star an entry.
   *
   * The entry must be visible to the user (subscribed feed, visibility rules).
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

      // Get the entry
      const entryResult = await ctx.db
        .select({
          id: entries.id,
          feedId: entries.feedId,
          fetchedAt: entries.fetchedAt,
        })
        .from(entries)
        .where(eq(entries.id, input.id))
        .limit(1);

      if (entryResult.length === 0) {
        throw errors.entryNotFound();
      }

      const entry = entryResult[0];

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
        throw errors.entryNotFound();
      }

      // Check visibility: entry.fetchedAt >= subscription.subscribedAt
      if (entry.fetchedAt < subscription[0].subscribedAt) {
        throw errors.entryNotFound();
      }

      // Upsert user entry state to star the entry
      await ctx.db
        .insert(userEntryStates)
        .values({
          userId,
          entryId: input.id,
          starred: true,
          starredAt: now,
        })
        .onConflictDoUpdate({
          target: [userEntryStates.userId, userEntryStates.entryId],
          set: {
            starred: true,
            starredAt: now,
          },
        });

      return {};
    }),

  /**
   * Unstar an entry.
   *
   * The entry must be visible to the user (subscribed feed, visibility rules).
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

      // Get the entry
      const entryResult = await ctx.db
        .select({
          id: entries.id,
          feedId: entries.feedId,
          fetchedAt: entries.fetchedAt,
        })
        .from(entries)
        .where(eq(entries.id, input.id))
        .limit(1);

      if (entryResult.length === 0) {
        throw errors.entryNotFound();
      }

      const entry = entryResult[0];

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
        throw errors.entryNotFound();
      }

      // Check visibility: entry.fetchedAt >= subscription.subscribedAt
      if (entry.fetchedAt < subscription[0].subscribedAt) {
        throw errors.entryNotFound();
      }

      // Upsert user entry state to unstar the entry
      await ctx.db
        .insert(userEntryStates)
        .values({
          userId,
          entryId: input.id,
          starred: false,
          starredAt: null,
        })
        .onConflictDoUpdate({
          target: [userEntryStates.userId, userEntryStates.entryId],
          set: {
            starred: false,
            starredAt: null,
          },
        });

      return {};
    }),
});
