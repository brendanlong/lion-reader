/**
 * Sync Router
 *
 * Provides incremental synchronization for pull-based updates.
 * Used as a fallback when SSE is unavailable or to catch up after disconnection.
 */

import { z } from "zod";

import {
  createTRPCRouter,
  confirmedProtectedProcedure as protectedProcedure,
  scopedProtectedProcedure,
} from "../trpc";
import { OAUTH_SCOPES } from "@/server/oauth/utils";
import { serverSyncEventSchema, unreadCountsSchema } from "@/lib/events/schemas";
import {
  collectSyncChanges,
  collectSyncEvents,
  currentSyncCursors,
  syncChangesInputSchema,
  syncChangesOutputSchema,
  syncCursorsInputSchema,
  syncCursorsSchema,
} from "@/server/services/sync";

const appProcedure = scopedProtectedProcedure(OAUTH_SCOPES.READER_FULL_ACCESS);

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
  /** On the last page: every active collection's counts (see collectSyncEvents). */
  counts: unreadCountsSchema.optional(),
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
  cursors: protectedProcedure
    .output(syncCursorsSchema)
    .query(({ ctx }) => currentSyncCursors(ctx.db, ctx.session.user.id)),

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
    .input(z.object({ cursors: syncCursorsInputSchema.optional() }))
    .output(syncEventsOutputSchema)
    .query(async ({ ctx, input }) => {
      const { events, hasMore, counts } = await collectSyncEvents(
        ctx.db,
        ctx.session.user.id,
        input.cursors ?? {},
        { collectionCounts: true }
      );
      return { events, hasMore, counts };
    }),
  /**
   * The native app's delta sync (`sync.events` over REST, plus what an offline
   * store needs that the web client doesn't): server-computed next cursors,
   * `deletions` (entries the user can no longer see: tombstones of hard-deleted
   * saved articles, and entries that left their view through a state change),
   * `collectionMemberships` (see listCollectionMemberships) for every entry
   * whose state the page re-delivers, and `resyncRequired` when the deletions cursor predates the tombstone
   * retention window.
   *
   * Called with no cursors, it returns no changes and the cursors to start
   * from — take them before downloading the initial window so nothing that
   * changes during the download is missed (replaying an overlap is harmless).
   * Page until `hasMore` is false, sending the first page's `entries` /
   * `entriesAfterId` as `entriesSince` / `entriesSinceAfterId` on every page
   * so changes an entry had before a later page's cursor are still reported.
   */
  changes: appProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/sync/changes",
        tags: ["Sync"],
        summary: "Changes since cursors",
      },
    })
    .input(syncChangesInputSchema)
    .output(syncChangesOutputSchema)
    .query(({ ctx, input }) => collectSyncChanges(ctx.db, ctx.session.user.id, input)),
});
