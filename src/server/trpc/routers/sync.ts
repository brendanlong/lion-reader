/**
 * Sync Router
 *
 * Provides incremental synchronization for pull-based updates.
 * Used as a fallback when SSE is unavailable or to catch up after disconnection.
 */

import { z } from "zod";
import { eq, and, isNull, gt, inArray, sql } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import {
  entries,
  feeds,
  subscriptions,
  userEntries,
  tags,
  visibleEntries,
  userFeeds,
} from "@/server/db/schema";

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of entries to return in a single sync response.
 * Prevents extremely large responses for initial syncs.
 */
const MAX_ENTRIES = 500;

/**
 * Maximum number of state updates to return.
 */
const MAX_STATE_UPDATES = 1000;

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Entry summary for sync (lightweight, no content).
 */
const syncEntrySchema = z.object({
  id: z.string(),
  subscriptionId: z.string().nullable(), // nullable for orphaned starred entries
  type: z.enum(["web", "email", "saved", "lesswrong"]),
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
 * Entry state update (read/starred changes).
 */
const syncEntryStateSchema = z.object({
  id: z.string(),
  read: z.boolean(),
  starred: z.boolean(),
});

/**
 * Subscription for sync.
 */
const syncSubscriptionSchema = z.object({
  id: z.string(),
  feedId: z.string(),
  feedTitle: z.string().nullable(),
  feedUrl: z.string().nullable(),
  feedType: z.enum(["web", "email", "saved", "lesswrong"]),
  customTitle: z.string().nullable(),
  subscribedAt: z.date(),
});

/**
 * Tag for sync.
 */
const syncTagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});

/**
 * Granular cursor schema for each query type.
 * Each cursor is derived from the actual last item in its respective query result,
 * ensuring no data is missed between syncs.
 */
const syncCursorsSchema = z.object({
  /** Cursor for new entries (based on entries.createdAt) */
  entries: z.string().datetime().nullable(),
  /** Cursor for entry state updates (based on userEntries.updatedAt) */
  entryStates: z.string().datetime().nullable(),
  /** Cursor for new subscriptions (based on subscriptions.createdAt) */
  subscriptions: z.string().datetime().nullable(),
  /** Cursor for removed subscriptions (based on subscriptions.unsubscribedAt) */
  removedSubscriptions: z.string().datetime().nullable(),
  /** Cursor for new tags (based on tags.createdAt) */
  tags: z.string().datetime().nullable(),
});

/**
 * Full sync response schema.
 */
const syncChangesOutputSchema = z.object({
  entries: z.object({
    created: z.array(syncEntrySchema),
    updated: z.array(syncEntryStateSchema),
    removed: z.array(z.string()),
  }),
  subscriptions: z.object({
    created: z.array(syncSubscriptionSchema),
    removed: z.array(z.string()),
  }),
  tags: z.object({
    created: z.array(syncTagSchema),
    removed: z.array(z.string()),
  }),
  /** Granular cursors for each query type (for correct incremental sync) */
  cursors: syncCursorsSchema,
  /** @deprecated Use `cursors` instead. Kept for backward compatibility. */
  syncedAt: z.string(),
  hasMore: z.boolean(),
});

// ============================================================================
// Router
// ============================================================================

export const syncRouter = createTRPCRouter({
  /**
   * Get changes since a given timestamp.
   *
   * Returns all entries, subscriptions, and tags that have changed since
   * the provided timestamp. If no timestamp is provided, returns a limited
   * set of recent data for initial sync.
   *
   * @param since - ISO 8601 timestamp to get changes since (optional)
   * @returns Changes grouped by entity type with a new syncedAt timestamp
   */
  changes: protectedProcedure
    // Note: No OpenAPI metadata - complex nested input (cursors) not supported in GET query params
    .input(
      z.object({
        /** @deprecated Use `cursors` for correct incremental sync */
        since: z.string().datetime().optional(),
        /** Granular cursors for each query type */
        cursors: z
          .object({
            entries: z.string().datetime().optional(),
            entryStates: z.string().datetime().optional(),
            subscriptions: z.string().datetime().optional(),
            removedSubscriptions: z.string().datetime().optional(),
            tags: z.string().datetime().optional(),
          })
          .optional(),
      })
    )
    .output(syncChangesOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // For backward compatibility, if cursors is not provided, use `since` for all queries
      // If neither is provided, this is an initial sync
      const legacySince = input.since ? new Date(input.since) : null;

      // Parse granular cursors (prefer granular over legacy)
      const entriesCursor = input.cursors?.entries ? new Date(input.cursors.entries) : legacySince;
      const entryStatesCursor = input.cursors?.entryStates
        ? new Date(input.cursors.entryStates)
        : legacySince;
      const subscriptionsCursor = input.cursors?.subscriptions
        ? new Date(input.cursors.subscriptions)
        : legacySince;
      const removedSubscriptionsCursor = input.cursors?.removedSubscriptions
        ? new Date(input.cursors.removedSubscriptions)
        : legacySince;
      const tagsCursor = input.cursors?.tags ? new Date(input.cursors.tags) : legacySince;

      // Track output cursors - derived from actual query results
      let outputEntriesCursor: Date | null = entriesCursor;
      let outputEntryStatesCursor: Date | null = entryStatesCursor;
      let outputSubscriptionsCursor: Date | null = subscriptionsCursor;
      let outputRemovedSubscriptionsCursor: Date | null = removedSubscriptionsCursor;
      let outputTagsCursor: Date | null = tagsCursor;

      // Track if we have more data than we're returning
      let hasMore = false;

      // ========================================================================
      // Fetch new entries (created since timestamp)
      // Using visible_entries view which handles visibility rules
      // ========================================================================
      let createdEntries: z.infer<typeof syncEntrySchema>[] = [];

      if (entriesCursor) {
        // Get entries created since the cursor that are visible to this user
        const newEntryResults = await ctx.db
          .select({
            id: visibleEntries.id,
            subscriptionId: visibleEntries.subscriptionId,
            type: visibleEntries.type,
            url: visibleEntries.url,
            title: visibleEntries.title,
            author: visibleEntries.author,
            summary: visibleEntries.summary,
            publishedAt: visibleEntries.publishedAt,
            fetchedAt: visibleEntries.fetchedAt,
            read: visibleEntries.read,
            starred: visibleEntries.starred,
            siteName: visibleEntries.siteName,
            createdAt: visibleEntries.createdAt,
            feedTitle: feeds.title,
          })
          .from(visibleEntries)
          .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
          .where(
            and(eq(visibleEntries.userId, userId), gt(visibleEntries.createdAt, entriesCursor))
          )
          .orderBy(visibleEntries.createdAt)
          .limit(MAX_ENTRIES + 1);

        if (newEntryResults.length > MAX_ENTRIES) {
          hasMore = true;
          newEntryResults.pop();
        }

        // Update cursor to the last entry's createdAt
        if (newEntryResults.length > 0) {
          const lastEntry = newEntryResults[newEntryResults.length - 1];
          outputEntriesCursor = lastEntry.createdAt;
        }

        createdEntries = newEntryResults.map((row) => ({
          id: row.id,
          subscriptionId: row.subscriptionId,
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
      } else {
        // Initial sync: get recent entries and establish initial cursor
        const recentEntryResults = await ctx.db
          .select({
            id: visibleEntries.id,
            subscriptionId: visibleEntries.subscriptionId,
            type: visibleEntries.type,
            url: visibleEntries.url,
            title: visibleEntries.title,
            author: visibleEntries.author,
            summary: visibleEntries.summary,
            publishedAt: visibleEntries.publishedAt,
            fetchedAt: visibleEntries.fetchedAt,
            read: visibleEntries.read,
            starred: visibleEntries.starred,
            siteName: visibleEntries.siteName,
            createdAt: visibleEntries.createdAt,
            feedTitle: feeds.title,
          })
          .from(visibleEntries)
          .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
          .where(eq(visibleEntries.userId, userId))
          .orderBy(sql`COALESCE(${visibleEntries.publishedAt}, ${visibleEntries.fetchedAt}) DESC`)
          .limit(MAX_ENTRIES + 1);

        if (recentEntryResults.length > MAX_ENTRIES) {
          hasMore = true;
          recentEntryResults.pop();
        }

        // For initial sync, set cursor to the max createdAt of returned entries
        // This establishes the baseline for future incremental syncs
        if (recentEntryResults.length > 0) {
          outputEntriesCursor = recentEntryResults.reduce(
            (max, row) => (row.createdAt > max ? row.createdAt : max),
            recentEntryResults[0].createdAt
          );
        }

        createdEntries = recentEntryResults.map((row) => ({
          id: row.id,
          subscriptionId: row.subscriptionId,
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
      }

      // ========================================================================
      // Fetch entry state updates (read/starred changes since timestamp)
      // ========================================================================
      let updatedEntryStates: z.infer<typeof syncEntryStateSchema>[] = [];

      if (entryStatesCursor) {
        // Get entry state changes since the cursor
        // Exclude entries that were just created (they're already in createdEntries)
        const createdEntryIds = new Set(createdEntries.map((e) => e.id));

        const stateUpdates = await ctx.db
          .select({
            entryId: userEntries.entryId,
            read: userEntries.read,
            starred: userEntries.starred,
            updatedAt: userEntries.updatedAt,
          })
          .from(userEntries)
          .innerJoin(entries, eq(entries.id, userEntries.entryId))
          .where(
            and(
              eq(userEntries.userId, userId),
              gt(userEntries.updatedAt, entryStatesCursor),
              // Exclude newly created entries (already in created list)
              sql`${entries.createdAt} <= ${entriesCursor ?? entryStatesCursor}`
            )
          )
          .orderBy(userEntries.updatedAt)
          .limit(MAX_STATE_UPDATES);

        // Update cursor to the last state update's updatedAt
        if (stateUpdates.length > 0) {
          const lastUpdate = stateUpdates[stateUpdates.length - 1];
          outputEntryStatesCursor = lastUpdate.updatedAt;
        }

        updatedEntryStates = stateUpdates
          .filter((u) => !createdEntryIds.has(u.entryId))
          .map((u) => ({
            id: u.entryId,
            read: u.read,
            starred: u.starred,
          }));
      }

      // ========================================================================
      // Fetch new subscriptions (created since timestamp)
      // ========================================================================
      let createdSubscriptions: z.infer<typeof syncSubscriptionSchema>[] = [];

      if (subscriptionsCursor) {
        // For incremental sync, need raw subscriptions table to filter by createdAt
        const newSubscriptionResults = await ctx.db
          .select({
            subscription: subscriptions,
            feed: feeds,
          })
          .from(subscriptions)
          .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
          .where(
            and(
              eq(subscriptions.userId, userId),
              isNull(subscriptions.unsubscribedAt),
              gt(subscriptions.createdAt, subscriptionsCursor)
            )
          )
          .orderBy(subscriptions.createdAt);

        // Update cursor to the last subscription's createdAt
        if (newSubscriptionResults.length > 0) {
          const lastSub = newSubscriptionResults[newSubscriptionResults.length - 1];
          outputSubscriptionsCursor = lastSub.subscription.createdAt;
        }

        createdSubscriptions = newSubscriptionResults.map(({ subscription, feed }) => ({
          id: subscription.id,
          feedId: subscription.feedId,
          feedTitle: feed.title,
          feedUrl: feed.url,
          feedType: feed.type,
          customTitle: subscription.customTitle,
          subscribedAt: subscription.subscribedAt,
        }));
      } else {
        // Initial sync: use user_feeds view for all active subscriptions
        const allSubscriptionResults = await ctx.db
          .select({
            id: userFeeds.id,
            feedId: userFeeds.feedId,
            feedTitle: userFeeds.originalTitle,
            feedUrl: userFeeds.url,
            feedType: userFeeds.type,
            customTitle: userFeeds.customTitle,
            subscribedAt: userFeeds.subscribedAt,
            createdAt: userFeeds.createdAt,
          })
          .from(userFeeds)
          .where(eq(userFeeds.userId, userId));

        // For initial sync, set cursor to the max createdAt of returned subscriptions
        if (allSubscriptionResults.length > 0) {
          outputSubscriptionsCursor = allSubscriptionResults.reduce(
            (max, row) => (row.createdAt > max ? row.createdAt : max),
            allSubscriptionResults[0].createdAt
          );
        }

        createdSubscriptions = allSubscriptionResults.map((row) => ({
          id: row.id,
          feedId: row.feedId,
          feedTitle: row.feedTitle,
          feedUrl: row.feedUrl,
          feedType: row.feedType,
          customTitle: row.customTitle,
          subscribedAt: row.subscribedAt,
        }));
      }

      // ========================================================================
      // Fetch removed subscriptions (unsubscribed since timestamp)
      // ========================================================================
      let removedSubscriptionIds: string[] = [];

      if (removedSubscriptionsCursor) {
        const unsubscribedResults = await ctx.db
          .select({
            id: subscriptions.id,
            unsubscribedAt: subscriptions.unsubscribedAt,
          })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.userId, userId),
              gt(subscriptions.unsubscribedAt, removedSubscriptionsCursor)
            )
          )
          .orderBy(subscriptions.unsubscribedAt);

        // Update cursor to the last unsubscribedAt
        if (unsubscribedResults.length > 0) {
          const lastRemoved = unsubscribedResults[unsubscribedResults.length - 1];
          outputRemovedSubscriptionsCursor = lastRemoved.unsubscribedAt;
        }

        removedSubscriptionIds = unsubscribedResults.map((s) => s.id);
      }

      // ========================================================================
      // Fetch new tags (created since timestamp)
      // ========================================================================
      let createdTags: z.infer<typeof syncTagSchema>[] = [];

      if (tagsCursor) {
        const newTagResults = await ctx.db
          .select({
            id: tags.id,
            name: tags.name,
            color: tags.color,
            createdAt: tags.createdAt,
          })
          .from(tags)
          .where(and(eq(tags.userId, userId), gt(tags.createdAt, tagsCursor)))
          .orderBy(tags.createdAt);

        // Update cursor to the last tag's createdAt
        if (newTagResults.length > 0) {
          const lastTag = newTagResults[newTagResults.length - 1];
          outputTagsCursor = lastTag.createdAt;
        }

        createdTags = newTagResults.map((row) => ({
          id: row.id,
          name: row.name,
          color: row.color,
        }));
      } else {
        // Initial sync: get all tags
        const allTagResults = await ctx.db
          .select({
            id: tags.id,
            name: tags.name,
            color: tags.color,
            createdAt: tags.createdAt,
          })
          .from(tags)
          .where(eq(tags.userId, userId));

        // For initial sync, set cursor to the max createdAt of returned tags
        if (allTagResults.length > 0) {
          outputTagsCursor = allTagResults.reduce(
            (max, row) => (row.createdAt > max ? row.createdAt : max),
            allTagResults[0].createdAt
          );
        }

        createdTags = allTagResults.map((row) => ({
          id: row.id,
          name: row.name,
          color: row.color,
        }));
      }

      // ========================================================================
      // Removed entries (entries from unsubscribed feeds that aren't starred)
      // ========================================================================
      let removedEntryIds: string[] = [];

      // Only process if this is an incremental sync and we have removed subscriptions
      if (removedSubscriptionsCursor && removedSubscriptionIds.length > 0) {
        // Get feed IDs for the removed subscriptions
        const removedFeedIds = await ctx.db
          .select({ feedId: subscriptions.feedId })
          .from(subscriptions)
          .where(inArray(subscriptions.id, removedSubscriptionIds));

        if (removedFeedIds.length > 0) {
          // Get entry IDs from those feeds that aren't starred
          const removedEntries = await ctx.db
            .select({ entryId: userEntries.entryId })
            .from(userEntries)
            .innerJoin(entries, eq(entries.id, userEntries.entryId))
            .where(
              and(
                eq(userEntries.userId, userId),
                inArray(
                  entries.feedId,
                  removedFeedIds.map((f) => f.feedId)
                ),
                eq(userEntries.starred, false)
              )
            );

          removedEntryIds = removedEntries.map((e) => e.entryId);
        }
      }

      // Note: Tag removal tracking would require a deleted_at column on tags
      // For now, clients can detect removed tags by comparing with previous sync
      const removedTagIds: string[] = [];

      // Compute syncedAt as the max of all output cursors for backward compatibility
      const allCursors = [
        outputEntriesCursor,
        outputEntryStatesCursor,
        outputSubscriptionsCursor,
        outputRemovedSubscriptionsCursor,
        outputTagsCursor,
      ].filter((c): c is Date => c !== null);

      const syncedAt =
        allCursors.length > 0
          ? new Date(Math.max(...allCursors.map((c) => c.getTime())))
          : new Date();

      return {
        entries: {
          created: createdEntries,
          updated: updatedEntryStates,
          removed: removedEntryIds,
        },
        subscriptions: {
          created: createdSubscriptions,
          removed: removedSubscriptionIds,
        },
        tags: {
          created: createdTags,
          removed: removedTagIds,
        },
        cursors: {
          entries: outputEntriesCursor?.toISOString() ?? null,
          entryStates: outputEntryStatesCursor?.toISOString() ?? null,
          subscriptions: outputSubscriptionsCursor?.toISOString() ?? null,
          removedSubscriptions: outputRemovedSubscriptionsCursor?.toISOString() ?? null,
          tags: outputTagsCursor?.toISOString() ?? null,
        },
        syncedAt: syncedAt.toISOString(),
        hasMore,
      };
    }),
});
