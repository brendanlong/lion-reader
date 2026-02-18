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
  subscriptionTags,
} from "@/server/db/schema";
import { syncTagSchema, serverSyncEventSchema } from "@/lib/events/schemas";

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of entries to return in a single sync response.
 * Prevents extremely large responses for initial syncs.
 */
const MAX_ENTRIES = 500;

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
 * Updated tag for sync (includes all modifiable fields).
 * Same shape as syncTagSchema — kept as a separate reference for clarity.
 */
const syncTagUpdatedSchema = syncTagSchema;

/**
 * Output schema for sync.events procedure.
 * Uses the shared server event schema (no defaults/transforms).
 */
const syncEventsOutputSchema = z.object({
  events: z.array(serverSyncEventSchema),
  hasMore: z.boolean(),
});

/**
 * Sync cursor schema.
 *
 * Uses a single cursor per entity type based on max(updated_at).
 * For entries, this combines entry metadata changes with read/starred state changes.
 * For subscriptions, this combines new subscriptions with unsubscribes (both update updated_at).
 */
const syncCursorsSchema = z.object({
  /** Cursor for entries - max of GREATEST(entries.updated_at, user_entries.updated_at) */
  entries: z.string().datetime().nullable(),
  /** Cursor for subscriptions - max(subscriptions.updated_at), covers both active and removed */
  subscriptions: z.string().datetime().nullable(),
  /** Cursor for tags - max(tags.updated_at), covers creates, updates, and soft deletes */
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
    updated: z.array(syncTagUpdatedSchema),
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
   * Get current sync cursors without fetching any data.
   *
   * This is an efficient way to establish cursors for real-time updates
   * without the overhead of a full sync. Used during SSR to get initial
   * cursors for the client-side SSE connection.
   *
   * @returns Cursors for each entity type based on max(updated_at)
   */
  cursors: protectedProcedure.output(syncCursorsSchema).query(async ({ ctx }) => {
    const userId = ctx.session.user.id;

    // Run all max queries in parallel for efficiency
    // SQL returns timestamps as strings, so we convert to ISO format
    const [entriesResult, subscriptionsResult, tagsResult] = await Promise.all([
      // Entries: max of GREATEST(entries.updated_at, user_entries.updated_at)
      // This catches both entry metadata changes AND read/starred state changes
      ctx.db
        .select({
          max: sql<string>`MAX(GREATEST(${entries.updatedAt}, ${userEntries.updatedAt}))::text`,
        })
        .from(userEntries)
        .innerJoin(entries, eq(entries.id, userEntries.entryId))
        .where(eq(userEntries.userId, userId)),

      // Subscriptions: max(updated_at) from ALL subscriptions (active and removed)
      // updated_at is set when unsubscribing, so this covers both cases
      ctx.db
        .select({ max: sql<string>`MAX(${subscriptions.updatedAt})::text` })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId)),

      // Tags: max(updated_at) - captures creates, updates, and soft deletes
      ctx.db
        .select({ max: sql<string>`MAX(${tags.updatedAt})::text` })
        .from(tags)
        .where(eq(tags.userId, userId)),
    ]);

    // Convert Postgres timestamp strings to ISO format
    const toIso = (val: string | null): string | null => {
      if (!val) return null;
      return new Date(val).toISOString();
    };

    return {
      entries: toIso(entriesResult[0]?.max ?? null),
      subscriptions: toIso(subscriptionsResult[0]?.max ?? null),
      tags: toIso(tagsResult[0]?.max ?? null),
    };
  }),

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
        /** Cursors for each entity type */
        cursors: z
          .object({
            entries: z.string().datetime().optional(),
            subscriptions: z.string().datetime().optional(),
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

      // Parse cursors (prefer explicit cursors over legacy `since`)
      const entriesCursor = input.cursors?.entries ? new Date(input.cursors.entries) : legacySince;
      const subscriptionsCursor = input.cursors?.subscriptions
        ? new Date(input.cursors.subscriptions)
        : legacySince;
      const tagsCursor = input.cursors?.tags ? new Date(input.cursors.tags) : legacySince;

      // Track output cursors - derived from actual query results
      let outputEntriesCursor: Date | null = entriesCursor;
      let outputSubscriptionsCursor: Date | null = subscriptionsCursor;
      let outputTagsCursor: Date | null = tagsCursor;

      // Track if we have more data than we're returning
      let hasMore = false;

      // ========================================================================
      // Fetch changed entries (metadata or state changes since timestamp)
      // Uses GREATEST(entries.updated_at, user_entries.updated_at) to catch all changes
      // with a single cursor. Results are split into:
      // - created: entries with metadata changes (need full cache update)
      // - updated: entries with only state changes (just read/starred)
      // ========================================================================
      let createdEntries: z.infer<typeof syncEntrySchema>[] = [];
      const updatedEntryStates: z.infer<typeof syncEntryStateSchema>[] = [];

      if (entriesCursor) {
        // Get entries where either the entry itself or its user state changed since cursor
        const changedEntryResults = await ctx.db
          .select({
            id: entries.id,
            feedId: entries.feedId,
            type: entries.type,
            url: entries.url,
            title: entries.title,
            author: entries.author,
            summary: entries.summary,
            siteName: entries.siteName,
            publishedAt: entries.publishedAt,
            fetchedAt: entries.fetchedAt,
            entryUpdatedAt: entries.updatedAt,
            read: userEntries.read,
            starred: userEntries.starred,
            userEntryUpdatedAt: userEntries.updatedAt,
            feedTitle: feeds.title,
            // Computed column for filtering and cursor
            maxUpdatedAt: sql<Date>`GREATEST(${entries.updatedAt}, ${userEntries.updatedAt})`,
          })
          .from(userEntries)
          .innerJoin(entries, eq(entries.id, userEntries.entryId))
          .innerJoin(feeds, eq(entries.feedId, feeds.id))
          // Join with subscriptions to get subscriptionId and check visibility
          .leftJoin(
            subscriptions,
            and(
              eq(subscriptions.userId, userEntries.userId),
              sql`${entries.feedId} = ANY(${subscriptions.feedIds})`,
              isNull(subscriptions.unsubscribedAt)
            )
          )
          .where(
            and(
              eq(userEntries.userId, userId),
              gt(sql`GREATEST(${entries.updatedAt}, ${userEntries.updatedAt})`, entriesCursor),
              // Visibility: either from active subscription or starred
              sql`(${subscriptions.id} IS NOT NULL OR ${userEntries.starred} = true)`
            )
          )
          .orderBy(sql`GREATEST(${entries.updatedAt}, ${userEntries.updatedAt})`)
          .limit(MAX_ENTRIES + 1);

        if (changedEntryResults.length > MAX_ENTRIES) {
          hasMore = true;
          changedEntryResults.pop();
        }

        // Update cursor to the max GREATEST from results
        // Note: sql<Date> is just a type hint - Postgres returns string timestamps
        if (changedEntryResults.length > 0) {
          const lastEntry = changedEntryResults[changedEntryResults.length - 1];
          outputEntriesCursor = new Date(lastEntry.maxUpdatedAt);
        }

        // Split results: metadata changes go to created, state-only changes go to updated
        for (const row of changedEntryResults) {
          // Get subscriptionId from the join (may be null for orphaned starred entries)
          const subscriptionId = (row as { subscriptionId?: string | null }).subscriptionId ?? null;

          if (row.entryUpdatedAt > entriesCursor) {
            // Entry metadata changed - include full data
            createdEntries.push({
              id: row.id,
              subscriptionId,
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
            });
          } else {
            // Only user state changed - lightweight update
            updatedEntryStates.push({
              id: row.id,
              read: row.read,
              starred: row.starred,
            });
          }
        }
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

        // For initial sync, set cursor to NOW() rather than max from results.
        // This is important because initial sync orders by publishedAt (for display),
        // but incremental sync filters by GREATEST(updated_at). An entry with high
        // updated_at but low publishedAt might not be in the top 500 by publishedAt,
        // but would appear in incremental sync. Using NOW() ensures we don't re-fetch
        // entries that existed when this query ran.
        outputEntriesCursor = new Date();

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
      // Fetch changed subscriptions (created, updated, or removed since timestamp)
      // Uses a single updated_at cursor - unsubscribing also updates updated_at
      // ========================================================================
      let createdSubscriptions: z.infer<typeof syncSubscriptionSchema>[] = [];
      const removedSubscriptionIds: string[] = [];

      if (subscriptionsCursor) {
        // For incremental sync, get all subscriptions changed since cursor
        // This includes new, modified, and unsubscribed - split by unsubscribedAt
        const changedSubscriptionResults = await ctx.db
          .select({
            subscription: subscriptions,
            feed: feeds,
          })
          .from(subscriptions)
          .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
          .where(
            and(eq(subscriptions.userId, userId), gt(subscriptions.updatedAt, subscriptionsCursor))
          )
          .orderBy(subscriptions.updatedAt);

        // Update cursor to the last subscription's updatedAt
        if (changedSubscriptionResults.length > 0) {
          const lastSub = changedSubscriptionResults[changedSubscriptionResults.length - 1];
          outputSubscriptionsCursor = lastSub.subscription.updatedAt;
        }

        // Split into active and removed
        for (const { subscription, feed } of changedSubscriptionResults) {
          if (subscription.unsubscribedAt === null) {
            // Active subscription (new or modified)
            createdSubscriptions.push({
              id: subscription.id,
              feedId: subscription.feedId,
              feedTitle: feed.title,
              feedUrl: feed.url,
              feedType: feed.type,
              customTitle: subscription.customTitle,
              subscribedAt: subscription.subscribedAt,
            });
          } else {
            // Removed subscription
            removedSubscriptionIds.push(subscription.id);
          }
        }
      } else {
        // Initial sync: get all active subscriptions and set cursor to max(updated_at)
        const allSubscriptionResults = await ctx.db
          .select({
            subscription: subscriptions,
            feed: feeds,
          })
          .from(subscriptions)
          .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
          .where(and(eq(subscriptions.userId, userId), isNull(subscriptions.unsubscribedAt)));

        // For initial sync, set cursor to the max updatedAt of ALL subscriptions (including removed)
        // This ensures we catch any unsubscribes that happen after this point
        // Note: sql<Date> is just a type hint - Postgres returns string timestamps
        const maxUpdatedAt = await ctx.db
          .select({ max: sql<string>`MAX(${subscriptions.updatedAt})` })
          .from(subscriptions)
          .where(eq(subscriptions.userId, userId))
          .then((rows) => rows[0]?.max ?? null);

        if (maxUpdatedAt) {
          outputSubscriptionsCursor = new Date(maxUpdatedAt);
        }

        createdSubscriptions = allSubscriptionResults.map(({ subscription, feed }) => ({
          id: subscription.id,
          feedId: subscription.feedId,
          feedTitle: feed.title,
          feedUrl: feed.url,
          feedType: feed.type,
          customTitle: subscription.customTitle,
          subscribedAt: subscription.subscribedAt,
        }));
      }

      // ========================================================================
      // Fetch changed tags (created, updated, or deleted since timestamp)
      // Uses updated_at which is set on all changes including soft deletes
      // ========================================================================
      let createdTags: z.infer<typeof syncTagSchema>[] = [];
      const updatedTags: z.infer<typeof syncTagUpdatedSchema>[] = [];
      const removedTagIds: string[] = [];

      if (tagsCursor) {
        // Incremental sync: get tags changed since cursor
        const changedTagResults = await ctx.db
          .select({
            id: tags.id,
            name: tags.name,
            color: tags.color,
            createdAt: tags.createdAt,
            updatedAt: tags.updatedAt,
            deletedAt: tags.deletedAt,
          })
          .from(tags)
          .where(and(eq(tags.userId, userId), gt(tags.updatedAt, tagsCursor)))
          .orderBy(tags.updatedAt);

        // Update cursor to the last tag's updatedAt
        if (changedTagResults.length > 0) {
          const lastTag = changedTagResults[changedTagResults.length - 1];
          outputTagsCursor = lastTag.updatedAt;
        }

        // Split into created, updated, and removed based on timestamps
        for (const row of changedTagResults) {
          if (row.deletedAt !== null) {
            // Tag was soft deleted
            removedTagIds.push(row.id);
          } else if (row.createdAt > tagsCursor) {
            // Tag was created after the cursor
            createdTags.push({
              id: row.id,
              name: row.name,
              color: row.color,
            });
          } else {
            // Tag existed before cursor but was updated
            updatedTags.push({
              id: row.id,
              name: row.name,
              color: row.color,
            });
          }
        }
      } else {
        // Initial sync: get all active (non-deleted) tags
        const allTagResults = await ctx.db
          .select({
            id: tags.id,
            name: tags.name,
            color: tags.color,
            updatedAt: tags.updatedAt,
          })
          .from(tags)
          .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)));

        // For initial sync, set cursor to max(updated_at) of ALL tags (including deleted)
        // This ensures we catch any deletes that happen after this point
        // Note: sql<Date> is just a type hint - Postgres returns string timestamps
        const maxUpdatedAt = await ctx.db
          .select({ max: sql<string>`MAX(${tags.updatedAt})` })
          .from(tags)
          .where(eq(tags.userId, userId))
          .then((rows) => rows[0]?.max ?? null);

        if (maxUpdatedAt) {
          outputTagsCursor = new Date(maxUpdatedAt);
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
      if (subscriptionsCursor && removedSubscriptionIds.length > 0) {
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

      // Compute syncedAt as the max of all output cursors for backward compatibility
      const allCursors = [outputEntriesCursor, outputSubscriptionsCursor, outputTagsCursor].filter(
        (c): c is Date => c !== null
      );

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
          updated: updatedTags,
          removed: removedTagIds,
        },
        cursors: {
          entries: outputEntriesCursor?.toISOString() ?? null,
          subscriptions: outputSubscriptionsCursor?.toISOString() ?? null,
          tags: outputTagsCursor?.toISOString() ?? null,
        },
        syncedAt: syncedAt.toISOString(),
        hasMore,
      };
    }),

  /**
   * Get changes since cursors as individual events (SSE-compatible format).
   *
   * This endpoint returns events in the same format as SSE, allowing the client
   * to use identical event handlers for both SSE and sync. Events are sorted
   * by timestamp and can be processed in order.
   *
   * Uses three separate cursors (one per entity type) for correct incremental sync,
   * matching the cursor tracking used in the SSE path.
   *
   * @param cursors - Per-entity-type cursors (entries, subscriptions, tags)
   * @returns Array of events with hasMore flag
   */
  events: protectedProcedure
    .input(
      z.object({
        cursors: z
          .object({
            entries: z.string().datetime().optional(),
            subscriptions: z.string().datetime().optional(),
            tags: z.string().datetime().optional(),
          })
          .optional(),
      })
    )
    .output(syncEventsOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const entriesCursor = input.cursors?.entries ? new Date(input.cursors.entries) : null;
      const subscriptionsCursor = input.cursors?.subscriptions
        ? new Date(input.cursors.subscriptions)
        : null;
      const tagsCursor = input.cursors?.tags ? new Date(input.cursors.tags) : null;

      // If no cursors provided, return empty events (initial cursor establishment
      // is handled by sync.cursors endpoint)
      if (!entriesCursor && !subscriptionsCursor && !tagsCursor) {
        return {
          events: [],
          hasMore: false,
        };
      }

      // Collect all events with their timestamps for sorting
      const allEvents: Array<z.infer<typeof serverSyncEventSchema> & { _sortTime: Date }> = [];

      // Track if we hit any limits
      let hasMore = false;

      // ========================================================================
      // Entry state changes (read/starred) - from user_entries.updated_at
      // ========================================================================
      if (entriesCursor) {
        const entryStateResults = await ctx.db
          .select({
            id: userEntries.entryId,
            read: userEntries.read,
            starred: userEntries.starred,
            updatedAt: userEntries.updatedAt,
          })
          .from(userEntries)
          .where(and(eq(userEntries.userId, userId), gt(userEntries.updatedAt, entriesCursor)))
          .orderBy(userEntries.updatedAt)
          .limit(MAX_ENTRIES + 1);

        if (entryStateResults.length > MAX_ENTRIES) {
          hasMore = true;
          entryStateResults.pop();
        }

        for (const row of entryStateResults) {
          allEvents.push({
            type: "entry_state_changed" as const,
            entryId: row.id,
            read: row.read,
            starred: row.starred,
            timestamp: row.updatedAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            _sortTime: row.updatedAt,
          });
        }

        // ======================================================================
        // Entry metadata changes - from entries.updated_at
        // Only include entries the user has access to (via user_entries)
        // ======================================================================
        const entryMetadataResults = await ctx.db
          .select({
            id: entries.id,
            title: entries.title,
            author: entries.author,
            summary: entries.summary,
            url: entries.url,
            publishedAt: entries.publishedAt,
            updatedAt: entries.updatedAt,
            subscriptionId: subscriptions.id,
          })
          .from(entries)
          .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
          .leftJoin(
            subscriptions,
            and(
              eq(subscriptions.userId, userId),
              sql`${entries.feedId} = ANY(${subscriptions.feedIds})`,
              isNull(subscriptions.unsubscribedAt)
            )
          )
          .where(
            and(
              eq(userEntries.userId, userId),
              gt(entries.updatedAt, entriesCursor),
              // Visibility: either from active subscription or starred
              sql`(${subscriptions.id} IS NOT NULL OR ${userEntries.starred} = true)`
            )
          )
          .orderBy(entries.updatedAt)
          .limit(MAX_ENTRIES + 1);

        if (entryMetadataResults.length > MAX_ENTRIES) {
          hasMore = true;
          entryMetadataResults.pop();
        }

        for (const row of entryMetadataResults) {
          allEvents.push({
            type: "entry_updated" as const,
            subscriptionId: row.subscriptionId,
            entryId: row.id,
            timestamp: row.updatedAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
            metadata: {
              title: row.title,
              author: row.author,
              summary: row.summary,
              url: row.url,
              publishedAt: row.publishedAt?.toISOString() ?? null,
            },
            _sortTime: row.updatedAt,
          });
        }
      }

      // ========================================================================
      // Subscription changes
      // ========================================================================
      if (subscriptionsCursor) {
        const subscriptionResults = await ctx.db
          .select({
            subscription: subscriptions,
            feed: feeds,
          })
          .from(subscriptions)
          .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
          .where(
            and(eq(subscriptions.userId, userId), gt(subscriptions.updatedAt, subscriptionsCursor))
          )
          .orderBy(subscriptions.updatedAt);

        // Collect active subscription IDs for batch tag/unread fetching
        const activeSubscriptions = subscriptionResults.filter(
          ({ subscription }) => subscription.unsubscribedAt === null
        );

        // Batch-fetch tags for all active subscriptions in one query
        const tagsBySubscription = new Map<
          string,
          Array<{ id: string; name: string; color: string | null }>
        >();
        if (activeSubscriptions.length > 0) {
          const allTagResults = await ctx.db
            .select({
              subscriptionId: subscriptionTags.subscriptionId,
              tagId: tags.id,
              tagName: tags.name,
              tagColor: tags.color,
            })
            .from(subscriptionTags)
            .innerJoin(tags, eq(tags.id, subscriptionTags.tagId))
            .where(
              inArray(
                subscriptionTags.subscriptionId,
                activeSubscriptions.map(({ subscription }) => subscription.id)
              )
            );

          for (const row of allTagResults) {
            const existing = tagsBySubscription.get(row.subscriptionId) ?? [];
            existing.push({ id: row.tagId, name: row.tagName, color: row.tagColor });
            tagsBySubscription.set(row.subscriptionId, existing);
          }
        }

        // Batch-fetch unread counts for all active subscriptions in one query
        const unreadBySubscription = new Map<string, number>();
        if (activeSubscriptions.length > 0) {
          // Build a single query that counts unread entries per subscription's feedIds
          // We use a subquery approach: for each subscription, count unread entries
          // matching any of its feedIds
          for (const { subscription } of activeSubscriptions) {
            // feedIds is an array column, so we need per-subscription queries
            // but we can run them in parallel
            unreadBySubscription.set(subscription.id, 0);
          }

          const unreadResults = await Promise.all(
            activeSubscriptions.map(async ({ subscription }) => {
              const result = await ctx.db
                .select({ count: sql<number>`count(*)::int` })
                .from(userEntries)
                .innerJoin(entries, eq(entries.id, userEntries.entryId))
                .where(
                  and(
                    eq(userEntries.userId, userId),
                    eq(userEntries.read, false),
                    sql`${entries.feedId} = ANY(${subscription.feedIds})`
                  )
                );
              return { subscriptionId: subscription.id, count: result[0]?.count ?? 0 };
            })
          );

          for (const { subscriptionId, count } of unreadResults) {
            unreadBySubscription.set(subscriptionId, count);
          }
        }

        for (const { subscription, feed } of subscriptionResults) {
          if (subscription.unsubscribedAt === null) {
            allEvents.push({
              type: "subscription_created" as const,
              subscriptionId: subscription.id,
              feedId: subscription.feedId,
              timestamp: subscription.updatedAt.toISOString(),
              updatedAt: subscription.updatedAt.toISOString(),
              subscription: {
                id: subscription.id,
                feedId: subscription.feedId,
                customTitle: subscription.customTitle,
                subscribedAt: subscription.subscribedAt.toISOString(),
                unreadCount: unreadBySubscription.get(subscription.id) ?? 0,
                tags: tagsBySubscription.get(subscription.id) ?? [],
              },
              feed: {
                id: feed.id,
                type: feed.type,
                url: feed.url,
                title: feed.title,
                description: feed.description,
                siteUrl: feed.siteUrl,
              },
              _sortTime: subscription.updatedAt,
            });
          } else {
            allEvents.push({
              type: "subscription_deleted" as const,
              subscriptionId: subscription.id,
              timestamp: subscription.updatedAt.toISOString(),
              updatedAt: subscription.updatedAt.toISOString(),
              _sortTime: subscription.updatedAt,
            });
          }
        }
      }

      // ========================================================================
      // Tag changes
      // ========================================================================
      if (tagsCursor) {
        const tagResults = await ctx.db
          .select({
            id: tags.id,
            name: tags.name,
            color: tags.color,
            createdAt: tags.createdAt,
            updatedAt: tags.updatedAt,
            deletedAt: tags.deletedAt,
          })
          .from(tags)
          .where(and(eq(tags.userId, userId), gt(tags.updatedAt, tagsCursor)))
          .orderBy(tags.updatedAt);

        for (const row of tagResults) {
          if (row.deletedAt !== null) {
            allEvents.push({
              type: "tag_deleted" as const,
              tagId: row.id,
              timestamp: row.updatedAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
              _sortTime: row.updatedAt,
            });
          } else if (row.createdAt > tagsCursor) {
            allEvents.push({
              type: "tag_created" as const,
              tag: {
                id: row.id,
                name: row.name,
                color: row.color,
              },
              timestamp: row.updatedAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
              _sortTime: row.updatedAt,
            });
          } else {
            allEvents.push({
              type: "tag_updated" as const,
              tag: {
                id: row.id,
                name: row.name,
                color: row.color,
              },
              timestamp: row.updatedAt.toISOString(),
              updatedAt: row.updatedAt.toISOString(),
              _sortTime: row.updatedAt,
            });
          }
        }
      }

      // Sort all events by timestamp
      allEvents.sort((a, b) => a._sortTime.getTime() - b._sortTime.getTime());

      // Remove _sortTime from events before returning
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const events = allEvents.map(({ _sortTime, ...event }) => event) as z.infer<
        typeof serverSyncEventSchema
      >[];

      return {
        events,
        hasMore,
      };
    }),
});
