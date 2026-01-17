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
  type: z.enum(["web", "email", "saved"]),
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
  feedType: z.enum(["web", "email", "saved"]),
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
    .meta({
      openapi: {
        method: "GET",
        path: "/sync",
        tags: ["Sync"],
        summary: "Get changes since timestamp",
      },
    })
    .input(
      z.object({
        since: z.string().datetime().optional(),
      })
    )
    .output(syncChangesOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const syncedAt = new Date();

      // Parse the since timestamp if provided
      const sinceDate = input.since ? new Date(input.since) : null;

      // Track if we have more data than we're returning
      let hasMore = false;

      // ========================================================================
      // Fetch new entries (created since timestamp)
      // Using visible_entries view which handles visibility rules
      // ========================================================================
      let createdEntries: z.infer<typeof syncEntrySchema>[] = [];

      if (sinceDate) {
        // Get entries created since the timestamp that are visible to this user
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
          .where(and(eq(visibleEntries.userId, userId), gt(visibleEntries.createdAt, sinceDate)))
          .orderBy(visibleEntries.createdAt)
          .limit(MAX_ENTRIES + 1);

        if (newEntryResults.length > MAX_ENTRIES) {
          hasMore = true;
          newEntryResults.pop();
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
        // Initial sync: get recent entries
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

      if (sinceDate) {
        // Get entry state changes since the timestamp
        // Exclude entries that were just created (they're already in createdEntries)
        const createdEntryIds = new Set(createdEntries.map((e) => e.id));

        const stateUpdates = await ctx.db
          .select({
            entryId: userEntries.entryId,
            read: userEntries.read,
            starred: userEntries.starred,
          })
          .from(userEntries)
          .innerJoin(entries, eq(entries.id, userEntries.entryId))
          .where(
            and(
              eq(userEntries.userId, userId),
              gt(userEntries.updatedAt, sinceDate),
              // Exclude newly created entries (already in created list)
              sql`${entries.createdAt} <= ${sinceDate}`
            )
          )
          .limit(MAX_STATE_UPDATES);

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

      if (sinceDate) {
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
              gt(subscriptions.createdAt, sinceDate)
            )
          );

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
          })
          .from(userFeeds)
          .where(eq(userFeeds.userId, userId));

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

      if (sinceDate) {
        const unsubscribedResults = await ctx.db
          .select({
            id: subscriptions.id,
          })
          .from(subscriptions)
          .where(
            and(eq(subscriptions.userId, userId), gt(subscriptions.unsubscribedAt, sinceDate))
          );

        removedSubscriptionIds = unsubscribedResults.map((s) => s.id);
      }

      // ========================================================================
      // Fetch new tags (created since timestamp)
      // ========================================================================
      let createdTags: z.infer<typeof syncTagSchema>[] = [];

      if (sinceDate) {
        const newTagResults = await ctx.db
          .select({
            id: tags.id,
            name: tags.name,
            color: tags.color,
          })
          .from(tags)
          .where(and(eq(tags.userId, userId), gt(tags.createdAt, sinceDate)));

        createdTags = newTagResults;
      } else {
        // Initial sync: get all tags
        const allTagResults = await ctx.db
          .select({
            id: tags.id,
            name: tags.name,
            color: tags.color,
          })
          .from(tags)
          .where(eq(tags.userId, userId));

        createdTags = allTagResults;
      }

      // ========================================================================
      // Removed entries (entries from unsubscribed feeds that aren't starred)
      // ========================================================================
      let removedEntryIds: string[] = [];

      if (sinceDate && removedSubscriptionIds.length > 0) {
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
        syncedAt: syncedAt.toISOString(),
        hasMore,
      };
    }),
});
