/**
 * Sync Router
 *
 * Provides incremental synchronization for pull-based updates.
 * Used as a fallback when SSE is unavailable or to catch up after disconnection.
 */

import { z } from "zod";
import { eq, and, inArray, sql } from "drizzle-orm";

import { createTRPCRouter, confirmedProtectedProcedure as protectedProcedure } from "../trpc";
import {
  entries,
  feeds,
  subscriptionFeeds,
  subscriptions,
  subscriptionTags,
  userEntries,
  tags,
  visibleEntries,
} from "@/server/db/schema";
import { syncTagSchema, serverSyncEventSchema } from "@/lib/events/schemas";
import type { Database } from "@/server/db";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Batch-fetch tags grouped by subscription ID.
 * Used by sync.events to avoid N+1 queries.
 */
async function fetchTagsBySubscriptionIds(
  db: Database,
  subscriptionIds: string[]
): Promise<Map<string, Array<z.infer<typeof syncTagSchema>>>> {
  const result = new Map<string, Array<z.infer<typeof syncTagSchema>>>();
  if (subscriptionIds.length === 0) return result;

  const rows = await db
    .select({
      subscriptionId: subscriptionTags.subscriptionId,
      tagId: tags.id,
      tagName: tags.name,
      tagColor: tags.color,
    })
    .from(subscriptionTags)
    .innerJoin(tags, eq(tags.id, subscriptionTags.tagId))
    .where(inArray(subscriptionTags.subscriptionId, subscriptionIds));

  for (const row of rows) {
    const existing = result.get(row.subscriptionId) ?? [];
    existing.push({ id: row.tagId, name: row.tagName, color: row.tagColor });
    result.set(row.subscriptionId, existing);
  }

  return result;
}

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
      // Entry changes (metadata and/or state) - combined query using GREATEST
      // Uses GREATEST(entries.updated_at, user_entries.updated_at) > cursor
      // to catch all changes with a single cursor, avoiding missed updates
      // when one timestamp advances past the other (see #738).
      // ========================================================================
      if (entriesCursor) {
        const entriesCursorDate = new Date(entriesCursor);
        const greatestUpdatedAt = sql`GREATEST(${entries.updatedAt}, ${userEntries.updatedAt})`;
        const changedEntryResults = await ctx.db
          .select({
            id: entries.id,
            title: entries.title,
            author: entries.author,
            summary: entries.summary,
            url: entries.url,
            publishedAt: entries.publishedAt,
            createdAt: entries.createdAt,
            entryUpdatedAt: entries.updatedAt,
            read: userEntries.read,
            starred: userEntries.starred,
            userEntryUpdatedAt: userEntries.updatedAt,
            subscriptionId: subscriptions.id,
            feedType: feeds.type,
            // Raw ISO string with µs precision for cursor/timestamp output
            maxUpdatedAtRaw: sql<string>`to_char(${greatestUpdatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(userEntries)
          .innerJoin(entries, eq(entries.id, userEntries.entryId))
          .innerJoin(feeds, eq(feeds.id, entries.feedId))
          .leftJoin(
            subscriptionFeeds,
            and(
              eq(subscriptionFeeds.userId, userEntries.userId),
              eq(subscriptionFeeds.feedId, entries.feedId)
            )
          )
          .leftJoin(subscriptions, eq(subscriptions.id, subscriptionFeeds.subscriptionId))
          .where(
            and(
              eq(userEntries.userId, userId),
              sql`${greatestUpdatedAt} > ${entriesCursor}::timestamptz`,
              // Visibility: match visible_entries view logic
              // LEFT JOIN produces NULL unsubscribedAt for saved articles (no subscription),
              // and NULL IS NULL = TRUE, so saved articles pass this check
              sql`(${subscriptions.unsubscribedAt} IS NULL OR ${userEntries.starred} = true)`
            )
          )
          .orderBy(greatestUpdatedAt)
          .limit(MAX_ENTRIES + 1);

        if (changedEntryResults.length > MAX_ENTRIES) {
          hasMore = true;
          changedEntryResults.pop();
        }

        // Differentiate event types based on which timestamps changed.
        // Both metadata and state can change simultaneously, so emit separate
        // events for each — the frontend handles them with different cache updates.
        for (const row of changedEntryResults) {
          const entryMetadataChanged = row.entryUpdatedAt > entriesCursorDate;
          const entryStateChanged = row.userEntryUpdatedAt > entriesCursorDate;
          const sortTime = new Date(row.maxUpdatedAtRaw);

          if (entryMetadataChanged) {
            if (row.createdAt > entriesCursorDate) {
              // New entry created after cursor - emit new_entry for count updates
              allEvents.push({
                type: "new_entry" as const,
                subscriptionId: row.subscriptionId,
                entryId: row.id,
                timestamp: row.maxUpdatedAtRaw,
                updatedAt: row.maxUpdatedAtRaw,
                feedType: row.feedType,
                _sortTime: sortTime,
              });
            } else {
              // Existing entry with metadata changes
              allEvents.push({
                type: "entry_updated" as const,
                subscriptionId: row.subscriptionId,
                entryId: row.id,
                timestamp: row.maxUpdatedAtRaw,
                updatedAt: row.maxUpdatedAtRaw,
                metadata: {
                  title: row.title,
                  author: row.author,
                  summary: row.summary,
                  url: row.url,
                  publishedAt: row.publishedAt?.toISOString() ?? null,
                },
                _sortTime: sortTime,
              });
            }
          }

          if (entryStateChanged) {
            // User state changed (read/starred) - emit separately from metadata
            // so the frontend updates both the entry content and read/starred state
            allEvents.push({
              type: "entry_state_changed" as const,
              entryId: row.id,
              read: row.read,
              starred: row.starred,
              timestamp: row.maxUpdatedAtRaw,
              updatedAt: row.maxUpdatedAtRaw,
              _sortTime: sortTime,
            });
          }
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
        const tagsBySubscription = await fetchTagsBySubscriptionIds(
          ctx.db,
          activeSubscriptions.map(({ subscription }) => subscription.id)
        );

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
