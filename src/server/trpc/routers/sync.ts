/**
 * Sync Router
 *
 * Provides incremental synchronization for pull-based updates.
 * Used as a fallback when SSE is unavailable or to catch up after disconnection.
 */

import { z } from "zod";
import { eq, and, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { Temporal } from "temporal-polyfill";

import { createTRPCRouter, confirmedProtectedProcedure as protectedProcedure } from "../trpc";
import {
  entries,
  feeds,
  subscriptions,
  subscriptionTags,
  userEntries,
  tags,
  visibleEntries,
} from "@/server/db/schema";
import { syncTagSchema, serverSyncEventSchema, toNewEntryListData } from "@/lib/events/schemas";
import type { Database } from "@/server/db";
import { parseTimestamptz, parseTimestamptzOrNull } from "@/server/db/temporal";
import { getBulkEntryRelatedCounts } from "@/server/services/counts";
import { getSavedFeedId } from "@/server/feed/saved-feed";

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
  /**
   * Id tiebreaker for the entries cursor. Together `(entries, entriesAfterId)`
   * form a keyset so a catch-up can page within a group of entries sharing one
   * timestamp (e.g. a large mark-all-read) instead of losing the tied rows to a
   * strict `>` comparison. It is the id of the entry achieving the max entries
   * timestamp; null when there are no entries.
   */
  entriesAfterId: z.string().uuid().nullable(),
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

    // Run all max queries in parallel for efficiency.
    // The pool returns Postgres's raw microsecond string for timestamptz, which
    // mapWith decodes to a full-precision Temporal.Instant — avoiding the
    // JavaScript Date truncation that caused cursor comparison bugs (#680, #683).
    const [entriesResult, subscriptionsResult, tagsResult] = await Promise.all([
      // Entries: newest GREATEST(entries.updated_at, user_entries.updated_at)
      // plus the id of the entry achieving it, forming the `(entries,
      // entriesAfterId)` keyset. This catches both entry metadata changes AND
      // read/starred state changes; the id lets a catch-up page within a tied
      // timestamp group. Ordered by (key DESC, id DESC) so LIMIT 1 is the argmax.
      ctx.db
        .select({
          max: sql`GREATEST(${entries.updatedAt}, ${userEntries.updatedAt})`.mapWith(
            parseTimestamptzOrNull
          ),
          maxId: entries.id,
        })
        .from(userEntries)
        .innerJoin(entries, eq(entries.id, userEntries.entryId))
        .where(eq(userEntries.userId, userId))
        .orderBy(
          sql`GREATEST(${entries.updatedAt}, ${userEntries.updatedAt}) DESC`,
          sql`${entries.id} DESC`
        )
        .limit(1),

      // Subscriptions: max(updated_at) from ALL subscriptions (active and removed)
      // updated_at is set when unsubscribing, so this covers both cases
      ctx.db
        .select({
          max: sql`MAX(${subscriptions.updatedAt})`.mapWith(parseTimestamptzOrNull),
        })
        .from(subscriptions)
        .where(eq(subscriptions.userId, userId)),

      // Tags: max(updated_at) - captures creates, updates, and soft deletes
      ctx.db
        .select({
          max: sql`MAX(${tags.updatedAt})`.mapWith(parseTimestamptzOrNull),
        })
        .from(tags)
        .where(eq(tags.userId, userId)),
    ]);

    return {
      entries: entriesResult[0]?.max?.toString() ?? null,
      entriesAfterId: entriesResult[0]?.maxId ?? null,
      subscriptions: subscriptionsResult[0]?.max?.toString() ?? null,
      tags: tagsResult[0]?.max?.toString() ?? null,
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
            /**
             * Id tiebreaker for the entries cursor (keyset pagination within a
             * tied-timestamp group). Optional for backward compatibility: when
             * absent the server falls back to a strict timestamp comparison.
             */
            entriesAfterId: z.string().uuid().optional(),
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

      // Collect all events with their timestamps for sorting. _sortTime is a
      // full-precision Temporal.Instant so tied-timestamp events sort correctly
      // (a JS Date would collapse sub-millisecond differences).
      const allEvents: Array<
        z.infer<typeof serverSyncEventSchema> & { _sortTime: Temporal.Instant }
      > = [];

      // Track if we hit any limits
      let hasMore = false;

      // ========================================================================
      // Entry changes (metadata and/or state) - combined query using GREATEST
      // Uses GREATEST(entries.updated_at, user_entries.updated_at) > cursor
      // to catch all changes with a single cursor, avoiding missed updates
      // when one timestamp advances past the other (see #738).
      //
      // Keyset pagination on (GREATEST(...), entry_id): markAllEntriesRead (and
      // the subscribe-time insert) stamp one identical timestamp onto hundreds
      // of rows, so a strict timestamp `>` cursor would drop every tied row past
      // the MAX_ENTRIES boundary permanently. Carrying the entry id as a
      // tiebreaker (same pattern as listEntries) lets the client page within a
      // tied-timestamp group. See #1080.
      //
      // The metadata/state/new booleans are computed in SQL against the same
      // (ts, id) keyset the selection uses — not with JavaScript Date math —
      // because new Date() truncates Postgres µs to ms, which could select a row
      // by µs precision yet then emit no event (leaving the cursor stuck). #1080
      // ========================================================================
      if (entriesCursor) {
        const entriesAfterId = input.cursors?.entriesAfterId ?? null;

        // `col` is "after" the keyset cursor when it is past the timestamp, or at
        // the timestamp with a larger entry id. Without an id tiebreaker (legacy
        // clients / first sync) fall back to a strict timestamp comparison.
        const afterCursor = (col: SQLWrapper): SQL =>
          entriesAfterId
            ? sql`(${col} > ${entriesCursor}::timestamptz OR (${col} = ${entriesCursor}::timestamptz AND ${entries.id} > ${entriesAfterId}::uuid))`
            : sql`${col} > ${entriesCursor}::timestamptz`;

        const greatest = sql`GREATEST(${entries.updatedAt}, ${userEntries.updatedAt})`;

        // ── Index-driven candidate set (issue #1105) ──────────────────────────
        // The delta filters and sorts on GREATEST(entries.updated_at,
        // user_entries.updated_at). That value spans two tables, so no index can
        // serve it: the old query scanned + sorted the user's ENTIRE history on
        // every call (LIMIT gave no help — the sort must see every row first).
        // This is the SSE-down polling fallback, so a Redis outage turned every
        // open tab into a repeating full-timeline scan.
        //
        // Since GREATEST(e, ue) > cursor  ⟺  e.updated_at > cursor OR
        // ue.updated_at > cursor, generate candidates from index-driven arms,
        // UNION them, then decorate + keyset the (now bounded) result:
        //
        //   Arm A  — user_entries.updated_at (idx_user_entries_updated_at). Covers
        //            every state change (read/star flips, mark-all-read) AND new
        //            entries: the feed fanout inserts user_entries rows with
        //            updated_at = now(), so new entries ride this arm too.
        //   Arm B1 — entries.updated_at for the user's SUBSCRIBED feeds. Catches
        //            content refetches that bump entries.updated_at WITHOUT
        //            touching the user_entries row (updateEntryContent) — the case
        //            Arm A misses. Drives from the user's subscriptions
        //            (uq_subscriptions_user_feed) into idx_entries_feed_updated_at
        //            per feed, seeking (feed_id, updated_at >= cursor) directly.
        //            NOTE: we deliberately do NOT pre-filter on
        //            feeds.last_entries_updated_at. It is stamped from the poll's
        //            start-time `now`, while each changed entry's updated_at is a
        //            later wall-clock read (createEntry/updateEntryContent write
        //            after the fetch+parse), so entry.updated_at > the feed's
        //            last_entries_updated_at by the fetch duration. A
        //            `last_entries_updated_at >= cursor` pre-filter would then
        //            wrongly prune a feed once the cursor advances past
        //            last_entries_updated_at but not past the entries — silently
        //            and permanently dropping the tail of a >MAX_ENTRIES same-poll
        //            content burst from the delta. The per-feed index seek already
        //            bounds the work; no pre-filter is needed.
        //   Arm B2 — same, for the user's saved-articles feed (no subscription
        //            row; saved feeds are never polled), keyed by the feed id.
        //
        // Arms compare with `>=` so a tied-timestamp boundary row is still a
        // candidate; the outer query re-applies the exact `(GREATEST, id)` keyset
        // (afterCursor) so pagination within a tied group stays correct (#1080).
        // Driving Arm B1 from subscriptions can surface an entry from an
        // unsubscribed feed, but the outer visibility predicate drops it unless
        // it is starred — matching visible_entries.
        const cursorTs = sql`${entriesCursor}::timestamptz`;

        const stateChangedCandidates = ctx.db
          .select({ entryId: userEntries.entryId })
          .from(userEntries)
          .where(and(eq(userEntries.userId, userId), sql`${userEntries.updatedAt} >= ${cursorTs}`));

        const subscribedEntryCandidates = ctx.db
          .select({ entryId: userEntries.entryId })
          .from(subscriptions)
          .innerJoin(
            entries,
            and(eq(entries.feedId, subscriptions.feedId), sql`${entries.updatedAt} >= ${cursorTs}`)
          )
          .innerJoin(
            userEntries,
            and(eq(userEntries.entryId, entries.id), eq(userEntries.userId, subscriptions.userId))
          )
          .where(eq(subscriptions.userId, userId));

        // Saved-articles arm: keyed by the saved feed id (no subscription row,
        // and last_entries_updated_at is never set on saved feeds).
        const savedFeedId = await getSavedFeedId(ctx.db, userId);
        const savedEntryCandidates = savedFeedId
          ? ctx.db
              .select({ entryId: userEntries.entryId })
              .from(userEntries)
              .innerJoin(
                entries,
                and(
                  eq(entries.id, userEntries.entryId),
                  eq(entries.feedId, savedFeedId),
                  sql`${entries.updatedAt} >= ${cursorTs}`
                )
              )
              .where(eq(userEntries.userId, userId))
          : null;

        const candidates = savedEntryCandidates
          ? stateChangedCandidates.union(subscribedEntryCandidates).union(savedEntryCandidates)
          : stateChangedCandidates.union(subscribedEntryCandidates);

        const changed = ctx.db.$with("changed_entries").as(candidates);

        const changedEntryResults = await ctx.db
          .with(changed)
          .select({
            id: entries.id,
            title: entries.title,
            author: entries.author,
            summary: entries.summary,
            url: entries.url,
            publishedAt: entries.publishedAt,
            fetchedAt: entries.fetchedAt,
            siteName: entries.siteName,
            isSpam: entries.isSpam,
            read: userEntries.read,
            starred: userEntries.starred,
            subscriptionId: subscriptions.id,
            feedId: entries.feedId,
            feedType: feeds.type,
            feedTitle: feeds.title,
            // Categorization booleans, computed in SQL at µs precision against
            // the keyset cursor so selection and categorization never disagree.
            metadataChanged: sql<boolean>`${afterCursor(entries.updatedAt)}`,
            stateChanged: sql<boolean>`${afterCursor(userEntries.updatedAt)}`,
            isNew: sql<boolean>`${afterCursor(entries.createdAt)}`,
            // Full-precision Temporal.Instant for cursor/timestamp output (both
            // updatedAt columns are NOT NULL, so GREATEST is never null here).
            maxUpdatedAt: sql`${greatest}`.mapWith(parseTimestamptz),
          })
          .from(changed)
          .innerJoin(
            userEntries,
            and(eq(userEntries.userId, userId), eq(userEntries.entryId, changed.entryId))
          )
          .innerJoin(entries, eq(entries.id, userEntries.entryId))
          .innerJoin(feeds, eq(feeds.id, entries.feedId))
          .leftJoin(subscriptions, eq(subscriptions.id, userEntries.subscriptionId))
          .where(
            and(
              afterCursor(greatest),
              // Fail-closed visibility, matching the visible_entries view
              // (migration 0073): an entry is visible only via an ACTIVE
              // subscription, being starred, or being a saved article. The old
              // `subscriptions.unsubscribed_at IS NULL` was fail-OPEN — for an
              // orphaned user_entries row the LEFT JOIN yields NULL and
              // `NULL IS NULL` = TRUE, leaking entries the web app hides. #1080
              sql`((${subscriptions.id} IS NOT NULL AND ${subscriptions.unsubscribedAt} IS NULL) OR ${userEntries.starred} = true OR ${entries.type} = 'saved')`
            )
          )
          // Direct join on the stamped user_entries.subscription_id — one
          // subscription per row by construction, so no fan-out is possible.
          .orderBy(greatest, entries.id)
          .limit(MAX_ENTRIES + 1);

        if (changedEntryResults.length > MAX_ENTRIES) {
          hasMore = true;
          changedEntryResults.pop();
        }

        // Differentiate event types based on which timestamps changed.
        // Both metadata and state can change simultaneously, so emit separate
        // events for each — the frontend handles them with different cache updates.

        // Collect entries with state changes for batch count computation
        const stateChangedEntries = changedEntryResults.filter((row) => row.stateChanged);

        // Entries created after the cursor emit new_entry events. Compute one
        // absolute-count snapshot covering all of them so each new_entry event
        // carries server-authoritative counts (the client sets them directly
        // rather than applying a +1 delta, making the events idempotent across
        // the live-SSE / catch-up-sync overlap).
        const newEntries = changedEntryResults.filter((row) => row.metadataChanged && row.isNew);
        const newEntryCounts =
          newEntries.length > 0
            ? await getBulkEntryRelatedCounts(
                ctx.db,
                userId,
                newEntries.map((row) => ({
                  subscriptionId: row.subscriptionId,
                  type: row.feedType,
                }))
              )
            : undefined;

        // Compute absolute unread counts once for all state-changed entries.
        // All entry_state_changed events share the same counts snapshot since
        // they reflect the current server state at query time.
        const stateChangedCounts =
          stateChangedEntries.length > 0
            ? await getBulkEntryRelatedCounts(
                ctx.db,
                userId,
                stateChangedEntries.map((row) => ({
                  subscriptionId: row.subscriptionId,
                  type: row.feedType,
                }))
              )
            : undefined;

        for (const row of changedEntryResults) {
          const entryMetadataChanged = row.metadataChanged;
          const entryStateChanged = row.stateChanged;

          if (entryMetadataChanged) {
            if (row.isNew) {
              // New entry created after cursor - emit new_entry for count and
              // list updates. The entry payload mirrors the live SSE path so a
              // catch-up sync inserts missed entries into cached lists too.
              // Unlike the live path, the entry may already have been read or
              // starred (on another device) since creation, so the payload
              // carries the actual state. Spam entries get no payload — the
              // default entries.list filters them, so a client-side insert
              // would show a row the server never returns.
              allEvents.push({
                type: "new_entry" as const,
                subscriptionId: row.subscriptionId,
                entryId: row.id,
                timestamp: row.maxUpdatedAt.toString(),
                updatedAt: row.maxUpdatedAt.toString(),
                feedType: row.feedType,
                feedId: row.feedId,
                ...(row.isSpam
                  ? {}
                  : {
                      entry: toNewEntryListData(row, row.feedTitle, {
                        read: row.read,
                        starred: row.starred,
                      }),
                    }),
                ...(newEntryCounts && { counts: newEntryCounts }),
                _sortTime: row.maxUpdatedAt,
              });
            } else {
              // Existing entry with metadata changes
              allEvents.push({
                type: "entry_updated" as const,
                subscriptionId: row.subscriptionId,
                entryId: row.id,
                timestamp: row.maxUpdatedAt.toString(),
                updatedAt: row.maxUpdatedAt.toString(),
                metadata: {
                  title: row.title,
                  author: row.author,
                  summary: row.summary,
                  url: row.url,
                  publishedAt: row.publishedAt?.toISOString() ?? null,
                },
                _sortTime: row.maxUpdatedAt,
              });
            }
          }

          if (entryStateChanged && stateChangedCounts) {
            // User state changed (read/starred) - emit separately from metadata
            // so the frontend updates both the entry content and read/starred state.
            allEvents.push({
              type: "entry_state_changed" as const,
              entryId: row.id,
              read: row.read,
              starred: row.starred,
              counts: stateChangedCounts,
              timestamp: row.maxUpdatedAt.toString(),
              updatedAt: row.maxUpdatedAt.toString(),
              _sortTime: row.maxUpdatedAt,
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
            updatedAtInstant: sql`${subscriptions.updatedAt}`.mapWith(parseTimestamptz),
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
        for (const { subscription, feed, updatedAtInstant } of subscriptionResults) {
          const updatedAtIso = updatedAtInstant.toString();
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
                timestamp: updatedAtIso,
                updatedAt: updatedAtIso,
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
                _sortTime: updatedAtInstant,
              });
            } else {
              allEvents.push({
                type: "subscription_updated" as const,
                subscriptionId: subscription.id,
                tags: tagsBySubscription.get(subscription.id) ?? [],
                customTitle: subscription.customTitle,
                timestamp: updatedAtIso,
                updatedAt: updatedAtIso,
                _sortTime: updatedAtInstant,
              });
            }
          } else {
            allEvents.push({
              type: "subscription_deleted" as const,
              subscriptionId: subscription.id,
              timestamp: updatedAtIso,
              updatedAt: updatedAtIso,
              _sortTime: updatedAtInstant,
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
            deletedAt: tags.deletedAt,
            updatedAtInstant: sql`${tags.updatedAt}`.mapWith(parseTimestamptz),
          })
          .from(tags)
          .where(and(eq(tags.userId, userId), sql`${tags.updatedAt} > ${tagsCursor}::timestamptz`))
          .orderBy(tags.updatedAt);

        for (const row of tagResults) {
          const updatedAtIso = row.updatedAtInstant.toString();
          if (row.deletedAt !== null) {
            allEvents.push({
              type: "tag_deleted" as const,
              tagId: row.id,
              timestamp: updatedAtIso,
              updatedAt: updatedAtIso,
              _sortTime: row.updatedAtInstant,
            });
          } else if (tagsCursorDate && row.createdAt > tagsCursorDate) {
            allEvents.push({
              type: "tag_created" as const,
              tag: {
                id: row.id,
                name: row.name,
                color: row.color,
              },
              timestamp: updatedAtIso,
              updatedAt: updatedAtIso,
              _sortTime: row.updatedAtInstant,
            });
          } else {
            allEvents.push({
              type: "tag_updated" as const,
              tag: {
                id: row.id,
                name: row.name,
                color: row.color,
              },
              timestamp: updatedAtIso,
              updatedAt: updatedAtIso,
              _sortTime: row.updatedAtInstant,
            });
          }
        }
      }

      // Sort all events by timestamp (µs-precise via Temporal.Instant.compare)
      allEvents.sort((a, b) => Temporal.Instant.compare(a._sortTime, b._sortTime));

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
