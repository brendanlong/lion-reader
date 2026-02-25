/**
 * Sync Router
 *
 * Provides incremental synchronization for pull-based updates.
 * Used as a fallback when SSE is unavailable or to catch up after disconnection.
 */

import { z } from "zod";
import { eq, and, isNull, inArray, sql } from "drizzle-orm";

import { createTRPCRouter, confirmedProtectedProcedure as protectedProcedure } from "../trpc";
import {
  entries,
  feeds,
  subscriptionFeeds,
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
    // Use to_char to format timestamps as ISO 8601 with microsecond precision.
    // Avoids JavaScript Date truncation which loses microseconds and causes
    // cursor comparison bugs (see #680).
    const [entriesResult, subscriptionsResult, tagsResult] = await Promise.all([
      // Entries: max of GREATEST(entries.updated_at, user_entries.updated_at)
      // This catches both entry metadata changes AND read/starred state changes
      ctx.db
        .select({
          max: sql<
            string | null
          >`to_char(MAX(GREATEST(${entries.updatedAt}, ${userEntries.updatedAt})) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(userEntries)
        .innerJoin(entries, eq(entries.id, userEntries.entryId))
        .where(eq(userEntries.userId, userId)),

      // Subscriptions: max(updated_at) from ALL subscriptions (active and removed)
      // updated_at is set when unsubscribing, so this covers both cases
      ctx.db
        .select({
          max: sql<
            string | null
          >`to_char(MAX(${subscriptions.updatedAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId)),

      // Tags: max(updated_at) - captures creates, updates, and soft deletes
      ctx.db
        .select({
          max: sql<
            string | null
          >`to_char(MAX(${tags.updatedAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        })
        .from(tags)
        .where(eq(tags.userId, userId)),
    ]);

    return {
      entries: entriesResult[0]?.max ?? null,
      subscriptions: subscriptionsResult[0]?.max ?? null,
      tags: tagsResult[0]?.max ?? null,
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
      // Keep cursors as strings to preserve Postgres microsecond precision (#680).
      // Using new Date() would truncate to milliseconds.
      const legacySince = input.since ?? null;

      // Parse cursors (prefer explicit cursors over legacy `since`)
      // String cursors for SQL comparisons (preserve µs precision)
      const entriesCursorStr = input.cursors?.entries ?? legacySince;
      const subscriptionsCursorStr = input.cursors?.subscriptions ?? legacySince;
      const tagsCursorStr = input.cursors?.tags ?? legacySince;
      // Date cursors for JavaScript comparisons (categorization only, ms precision acceptable)
      const entriesCursorDate = entriesCursorStr ? new Date(entriesCursorStr) : null;
      const tagsCursorDate = tagsCursorStr ? new Date(tagsCursorStr) : null;

      // Track output cursors as ISO strings with µs precision
      let outputEntriesCursor: string | null = entriesCursorStr;
      let outputSubscriptionsCursor: string | null = subscriptionsCursorStr;
      let outputTagsCursor: string | null = tagsCursorStr;

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

      if (entriesCursorStr) {
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
            // Raw ISO string with µs precision for cursor output
            maxUpdatedAtRaw: sql<string>`to_char(GREATEST(${entries.updatedAt}, ${userEntries.updatedAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(userEntries)
          .innerJoin(entries, eq(entries.id, userEntries.entryId))
          .innerJoin(feeds, eq(entries.feedId, feeds.id))
          // Join with subscriptions via subscription_feeds to get subscriptionId and check visibility
          .leftJoin(
            subscriptionFeeds,
            and(
              eq(subscriptionFeeds.userId, userEntries.userId),
              eq(subscriptionFeeds.feedId, entries.feedId)
            )
          )
          .leftJoin(
            subscriptions,
            and(
              eq(subscriptions.id, subscriptionFeeds.subscriptionId),
              isNull(subscriptions.unsubscribedAt)
            )
          )
          .where(
            and(
              eq(userEntries.userId, userId),
              // Pass cursor string directly to Postgres to preserve µs precision
              sql`GREATEST(${entries.updatedAt}, ${userEntries.updatedAt}) > ${entriesCursorStr}::timestamptz`,
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

        // Update cursor to the max GREATEST from results (µs-precision ISO string)
        if (changedEntryResults.length > 0) {
          const lastEntry = changedEntryResults[changedEntryResults.length - 1];
          outputEntriesCursor = lastEntry.maxUpdatedAtRaw;
        }

        // Split results: metadata changes go to created, state-only changes go to updated
        for (const row of changedEntryResults) {
          // Get subscriptionId from the join (may be null for orphaned starred entries)
          const subscriptionId = (row as { subscriptionId?: string | null }).subscriptionId ?? null;

          // Use Date comparison for categorization (ms precision acceptable here)
          if (entriesCursorDate && row.entryUpdatedAt > entriesCursorDate) {
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

        // For initial sync, set cursor to NOW() from Postgres rather than JS Date.
        // Using Postgres NOW() preserves µs precision and avoids clock skew.
        // This is important because initial sync orders by publishedAt (for display),
        // but incremental sync filters by GREATEST(updated_at). An entry with high
        // updated_at but low publishedAt might not be in the top 500 by publishedAt,
        // but would appear in incremental sync. Using NOW() ensures we don't re-fetch
        // entries that existed when this query ran.
        const nowResult = await ctx.db.execute<{ now: string }>(
          sql`SELECT to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`
        );
        outputEntriesCursor = nowResult.rows[0].now;

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

      if (subscriptionsCursorStr) {
        // For incremental sync, get all subscriptions changed since cursor
        // This includes new, modified, and unsubscribed - split by unsubscribedAt
        const changedSubscriptionResults = await ctx.db
          .select({
            subscription: subscriptions,
            feed: feeds,
            updatedAtRaw: sql<string>`to_char(${subscriptions.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(subscriptions)
          .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
          .where(
            and(
              eq(subscriptions.userId, userId),
              sql`${subscriptions.updatedAt} > ${subscriptionsCursorStr}::timestamptz`
            )
          )
          .orderBy(subscriptions.updatedAt);

        // Update cursor to the last subscription's updatedAt (µs precision)
        if (changedSubscriptionResults.length > 0) {
          const lastSub = changedSubscriptionResults[changedSubscriptionResults.length - 1];
          outputSubscriptionsCursor = lastSub.updatedAtRaw;
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
        const maxUpdatedAt = await ctx.db
          .select({
            max: sql<
              string | null
            >`to_char(MAX(${subscriptions.updatedAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(subscriptions)
          .where(eq(subscriptions.userId, userId))
          .then((rows) => rows[0]?.max ?? null);

        if (maxUpdatedAt) {
          outputSubscriptionsCursor = maxUpdatedAt;
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

      if (tagsCursorStr) {
        // Incremental sync: get tags changed since cursor
        const changedTagResults = await ctx.db
          .select({
            id: tags.id,
            name: tags.name,
            color: tags.color,
            createdAt: tags.createdAt,
            updatedAt: tags.updatedAt,
            deletedAt: tags.deletedAt,
            updatedAtRaw: sql<string>`to_char(${tags.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(tags)
          .where(
            and(eq(tags.userId, userId), sql`${tags.updatedAt} > ${tagsCursorStr}::timestamptz`)
          )
          .orderBy(tags.updatedAt);

        // Update cursor to the last tag's updatedAt (µs precision)
        if (changedTagResults.length > 0) {
          const lastTag = changedTagResults[changedTagResults.length - 1];
          outputTagsCursor = lastTag.updatedAtRaw;
        }

        // Split into created, updated, and removed based on timestamps
        for (const row of changedTagResults) {
          if (row.deletedAt !== null) {
            // Tag was soft deleted
            removedTagIds.push(row.id);
          } else if (tagsCursorDate && row.createdAt > tagsCursorDate) {
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
        const maxUpdatedAt = await ctx.db
          .select({
            max: sql<
              string | null
            >`to_char(MAX(${tags.updatedAt}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(tags)
          .where(eq(tags.userId, userId))
          .then((rows) => rows[0]?.max ?? null);

        if (maxUpdatedAt) {
          outputTagsCursor = maxUpdatedAt;
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
      if (subscriptionsCursorStr && removedSubscriptionIds.length > 0) {
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

      // Compute syncedAt as the max of all output cursors for backward compatibility.
      // ISO 8601 strings in UTC with fixed format are lexicographically sortable.
      const allCursors = [outputEntriesCursor, outputSubscriptionsCursor, outputTagsCursor].filter(
        (c): c is string => c !== null
      );

      const syncedAt =
        allCursors.length > 0
          ? allCursors.reduce((a, b) => (a > b ? a : b))
          : new Date().toISOString();

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
          entries: outputEntriesCursor,
          subscriptions: outputSubscriptionsCursor,
          tags: outputTagsCursor,
        },
        syncedAt,
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

      // Keep cursors as strings to preserve Postgres µs precision (#680)
      const entriesCursor = input.cursors?.entries ?? null;
      const subscriptionsCursor = input.cursors?.subscriptions ?? null;
      const tagsCursor = input.cursors?.tags ?? null;
      // Date versions for JavaScript comparisons (categorization, sorting)
      const tagsCursorDate = tagsCursor ? new Date(tagsCursor) : null;

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
            updatedAtRaw: sql<string>`to_char(${userEntries.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(userEntries)
          .where(
            and(
              eq(userEntries.userId, userId),
              sql`${userEntries.updatedAt} > ${entriesCursor}::timestamptz`
            )
          )
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
            timestamp: row.updatedAtRaw,
            updatedAt: row.updatedAtRaw,
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
            updatedAtRaw: sql<string>`to_char(${entries.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
            subscriptionId: subscriptions.id,
          })
          .from(entries)
          .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
          .leftJoin(
            subscriptionFeeds,
            and(eq(subscriptionFeeds.userId, userId), eq(subscriptionFeeds.feedId, entries.feedId))
          )
          .leftJoin(
            subscriptions,
            and(
              eq(subscriptions.id, subscriptionFeeds.subscriptionId),
              isNull(subscriptions.unsubscribedAt)
            )
          )
          .where(
            and(
              eq(userEntries.userId, userId),
              sql`${entries.updatedAt} > ${entriesCursor}::timestamptz`,
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
            timestamp: row.updatedAtRaw,
            updatedAt: row.updatedAtRaw,
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
            updatedAtRaw: sql<string>`to_char(${subscriptions.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(subscriptions)
          .innerJoin(feeds, eq(subscriptions.feedId, feeds.id))
          .where(
            and(
              eq(subscriptions.userId, userId),
              sql`${subscriptions.updatedAt} > ${subscriptionsCursor}::timestamptz`
            )
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
          const activeSubscriptionIds = activeSubscriptions.map(
            ({ subscription }) => subscription.id
          );

          const unreadResults = await ctx.db
            .select({
              subscriptionId: visibleEntries.subscriptionId,
              count: sql<number>`count(*)::int`,
            })
            .from(visibleEntries)
            .where(
              and(
                eq(visibleEntries.userId, userId),
                eq(visibleEntries.read, false),
                inArray(visibleEntries.subscriptionId, activeSubscriptionIds)
              )
            )
            .groupBy(visibleEntries.subscriptionId);

          for (const { subscriptionId, count } of unreadResults) {
            // subscriptionId is guaranteed non-null by the inArray filter above
            unreadBySubscription.set(subscriptionId!, count);
          }
        }

        const subscriptionsCursorDate = new Date(subscriptionsCursor);
        for (const { subscription, feed, updatedAtRaw } of subscriptionResults) {
          if (subscription.unsubscribedAt === null) {
            // Distinguish new subscriptions from updated ones:
            // If subscribedAt is after the cursor, it's a new subscription.
            // Otherwise, it's an existing subscription whose properties changed.
            const isNew = subscription.subscribedAt > subscriptionsCursorDate;
            if (isNew) {
              allEvents.push({
                type: "subscription_created" as const,
                subscriptionId: subscription.id,
                feedId: subscription.feedId,
                timestamp: updatedAtRaw,
                updatedAt: updatedAtRaw,
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
                type: "subscription_updated" as const,
                subscriptionId: subscription.id,
                tags: tagsBySubscription.get(subscription.id) ?? [],
                customTitle: subscription.customTitle,
                timestamp: updatedAtRaw,
                updatedAt: updatedAtRaw,
                _sortTime: subscription.updatedAt,
              });
            }
          } else {
            allEvents.push({
              type: "subscription_deleted" as const,
              subscriptionId: subscription.id,
              timestamp: updatedAtRaw,
              updatedAt: updatedAtRaw,
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
            updatedAtRaw: sql<string>`to_char(${tags.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(tags)
          .where(and(eq(tags.userId, userId), sql`${tags.updatedAt} > ${tagsCursor}::timestamptz`))
          .orderBy(tags.updatedAt);

        for (const row of tagResults) {
          if (row.deletedAt !== null) {
            allEvents.push({
              type: "tag_deleted" as const,
              tagId: row.id,
              timestamp: row.updatedAtRaw,
              updatedAt: row.updatedAtRaw,
              _sortTime: row.updatedAt,
            });
          } else if (tagsCursorDate && row.createdAt > tagsCursorDate) {
            allEvents.push({
              type: "tag_created" as const,
              tag: {
                id: row.id,
                name: row.name,
                color: row.color,
              },
              timestamp: row.updatedAtRaw,
              updatedAt: row.updatedAtRaw,
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
              timestamp: row.updatedAtRaw,
              updatedAt: row.updatedAtRaw,
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
