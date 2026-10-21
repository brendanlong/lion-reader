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

import {
  createTRPCRouter,
  confirmedProtectedProcedure as protectedProcedure,
  scopedProtectedProcedure,
} from "../trpc";
import { READER_SCOPES } from "@/server/auth/api-token";
import { OAUTH_SCOPES } from "@/server/oauth/utils";
import {
  booleanQueryParam,
  entryCountInputSchema,
  entryListInputSchema,
  uuidSchema,
} from "../validation";
import * as fullContentService from "@/server/services/full-content";
import * as entriesService from "@/server/services/entries";
import * as entryReadsService from "@/server/services/entry-reads";
import * as entryStateService from "@/server/services/entry-state";
import { toServerTime } from "@/server/services/client-time";
import { countsAsOfSchema, unreadCountsSchema } from "@/lib/events/schemas";
import { ENTRY_TYPES } from "@/lib/entry-types";

// Endpoints exposed via the MCP tool surface, plus the ones the native app needs.
const readerProcedure = scopedProtectedProcedure(READER_SCOPES);
// Endpoints only the native app needs.
const appProcedure = scopedProtectedProcedure(OAUTH_SCOPES.READER_FULL_ACCESS);

// ============================================================================
// Constants
// ============================================================================

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * The client's clock when it sent a state write; per-entry `changedAt`s are
 * shifted by its offset from the server clock (see toServerTime).
 */
const clientSentAtSchema = z.coerce.date().optional();

/** Per-entry state writes, each with its own change time (offline replay). */
const stateChangeEntriesSchema = z
  .array(
    z.object({
      id: uuidSchema,
      changedAt: z.coerce.date().optional(),
    })
  )
  .min(1, "At least one entry is required")
  .max(
    entryStateService.MAX_ENTRY_STATE_BATCH,
    `Maximum ${entryStateService.MAX_ENTRY_STATE_BATCH} entries per request`
  );

const feedTypeSchema = z.enum(ENTRY_TYPES);

// ============================================================================
// Output Schemas
// ============================================================================

const entryListItemSchema = entriesService.entryListItemSchema;

const entryFullSchema = entryReadsService.fullEntrySchema;

/**
 * Paginated entries list output schema.
 */
const entriesListOutputSchema = z.object({
  items: z.array(entryListItemSchema),
  nextCursor: z.string().optional(),
  /** On the first page: which ranked sorts the list has values for. */
  sortable: entriesService.entrySortableSchema.optional(),
  /** On the first page: the sort the list is in, which a request without one leaves to the list. */
  sort: entriesService.entrySortSchema.optional(),
});

/**
 * Result of a bulk read/star write: the final state of every requested entry the
 * user can still see (an id missing here no longer exists for them), for cache
 * updates and offline-outbox reconciliation.
 */
const bulkStateChangeOutputSchema = z.object({
  success: z.boolean(),
  count: z.number(),
  entries: z.array(entryStateService.markReadEntryStateSchema),
  // Absolute counts for all affected lists. Absent when no value actually
  // flipped (same-value re-assert) — the client's cached counts are already
  // correct (issue #1118).
  counts: unreadCountsSchema.optional(),
});

/**
 * Output schema for setStarred mutation.
 * Returns the updated entry with new starred state and counts.
 */
const setStarredOutputSchema = z.object({
  entry: entryStateService.entryStateSchema,
  // Absent when the starred value didn't actually flip (same-value re-assert)
  // — the client's cached counts are already correct (issue #1118).
  counts: unreadCountsSchema.optional(),
});

// ============================================================================
// Router
// ============================================================================
//
// Full-entry reads go through `entryReadsService.getFullEntry`, which sanitizes
// the content (the read-path sanitization chokepoint lives in the services
// layer so MCP, Google Reader, and Wallabag get the same guarantee).

export const entriesRouter = createTRPCRouter({
  /**
   * List entries with filters and cursor-based pagination.
   *
   * Supports optional full-text search via the query parameter.
   * When query is provided, searches both title and content and ranks by relevance.
   * Without query, returns entries sorted by time.
   *
   * @param query - Optional full-text search query (searches title and content)
   * @param subscriptionId - Optional filter by subscription ID
   * @param tagId - Optional filter by tag ID (entries from subscriptions with this tag)
   * @param uncategorized - Optional filter to show only entries from uncategorized subscriptions
   * @param type - Optional filter by entry type (web/email/saved)
   * @param excludeTypes - Optional array of types to exclude
   * @param unreadOnly - Optional filter to show only unread entries
   * @param starredOnly - Optional filter to show only starred entries
   * @param sortBy - Optional sort: "published" (default), "readChanged", "score" or "position" (a collection's list only)
   * @param sortOrder - Optional direction of sortBy: newest/oldest, highest/lowest or first/last (its first by default). Ignored when query is provided.
   * @param cursor - Optional pagination cursor (from previous response)
   * @param limit - Optional number of entries per page (default: 50, max: 100)
   * @returns Paginated list of entries
   */
  list: readerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/entries",
        tags: ["Entries"],
        summary: "List entries",
      },
    })
    .input(
      entryListInputSchema().extend({
        uncategorized: booleanQueryParam,
        unreadOnly: booleanQueryParam,
        starredOnly: booleanQueryParam,
        excludeTypes: z.array(feedTypeSchema).optional(),
      })
    )
    .output(entriesListOutputSchema)
    .query(async ({ ctx, input }) => {
      const page = await entriesService.listEntries(ctx.db, {
        ...input,
        userId: ctx.session.user.id,
        showSpam: ctx.session.user.showSpam,
      });
      return page;
    }),

  // REST routes match in procedure order, so `GET /entries/count` must come
  // before `GET /entries/{id}` or the count request is read as an entry id.
  /**
   * Unread count of one list (its badge): All, or at most one of
   * subscriptionId, tagId, uncategorized, type "saved" and starredOnly
   * (`countEntries`).
   */
  count: readerProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/entries/count",
        tags: ["Entries"],
        summary: "Get entries count",
      },
    })
    .input(
      entryCountInputSchema()
        .extend({ uncategorized: booleanQueryParam, starredOnly: booleanQueryParam })
        .optional()
    )
    .output(
      z.object({
        unread: z.number(),
        asOf: countsAsOfSchema,
      })
    )
    .query(async ({ ctx, input }) => {
      return entriesService.countEntries(ctx.db, ctx.session.user.id, { ...input });
    }),

  /** The All, Starred, Saved and Uncategorized badges at once (`countUserLists`). */
  countLists: protectedProcedure
    .output(
      z.object({
        all: z.number(),
        starred: z.number(),
        saved: z.number(),
        uncategorized: z.number(),
        asOf: countsAsOfSchema,
      })
    )
    .query(async ({ ctx }) => {
      return entriesService.countUserLists(ctx.db, ctx.session.user.id);
    }),

  /**
   * Get a single entry by ID with full content.
   *
   * The entry is visible to a user only if they have a corresponding
   * row in the user_entries table for their user_id.
   *
   * Includes subscription data (fetchFullContent, tags) to avoid separate
   * subscriptions.get query on the client.
   *
   * @param id - The entry ID
   * @returns The full entry with content and subscription data
   */
  get: readerProcedure
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

      const { entry } = await entryReadsService.getFullEntry(ctx.db, userId, input.id);
      return { entry };
    }),

  /**
   * Get many full entries at once, in `entries.get`'s shape plus the `content`
   * each shows by default. Ids the user can't see are omitted. Used by the
   * native app to download entries for offline reading.
   */
  getMany: appProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/entries/batch",
        tags: ["Entries"],
        summary: "Get many entries",
      },
    })
    .input(
      z.object({
        ids: z.array(uuidSchema).min(1).max(entriesService.MAX_ENTRIES_PAGE_SIZE),
      })
    )
    .output(z.object({ entries: z.array(entryReadsService.offlineEntrySchema) }))
    .query(async ({ ctx, input }) => {
      return {
        entries: await entryReadsService.getFullEntries(ctx.db, ctx.session.user.id, input.ids),
      };
    }),

  /**
   * Mark entries as read or unread (bulk operation).
   *
   * Only entries the user has access to (via user_entries) will be updated.
   * Returns entries with subscription context for client-side cache updates.
   *
   * Supports per-entry timestamps for offline sync scenarios where each entry
   * was marked at a different time.
   *
   * @param entries - Array of entry IDs with optional per-entry timestamps
   * @param read - Whether to mark as read (true) or unread (false)
   * @returns The updated entries with subscription context for cache updates
   */
  markRead: readerProcedure
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
        entries: stateChangeEntriesSchema,
        read: z.boolean(),
        clientSentAt: clientSentAtSchema,
      })
    )
    .output(bulkStateChangeOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // markEntriesRead computes the absolute counts and publishes the
      // entry_state_changed SSE events itself (so every caller — tRPC, MCP, and
      // the Google Reader/Wallabag compat routes — notifies other tabs).
      const now = new Date();
      const { entries: entriesResult, counts } = await entryStateService.markEntriesRead(
        ctx.db,
        userId,
        input.entries.map((entry) => ({
          id: entry.id,
          changedAt: toServerTime(entry.changedAt, input.clientSentAt, now),
        })),
        input.read
      );

      return {
        success: true,
        count: entriesResult.length,
        entries: entriesResult,
        counts,
      };
    }),

  /**
   * Mark all entries as read with optional filters.
   *
   * @param subscriptionId - Optional filter to mark only entries from a specific subscription
   * @param tagId - Optional filter to mark only entries from subscriptions with this tag
   * @param starredOnly - Optional filter to mark only starred entries
   * @param before - Optional filter to mark only entries fetched before this date
   * @returns The count of entries marked as read
   */
  markAllRead: appProcedure
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
        subscriptionId: uuidSchema.optional(),
        tagId: uuidSchema.optional(),
        uncategorized: z.boolean().optional(),
        starredOnly: z.boolean().optional(),
        type: feedTypeSchema.optional(),
        // Compared with entries' server-side fetchedAt, so it's server time (a
        // fetchedAt the client saw) and, unlike changedAt, isn't rebased.
        before: z.coerce.date().optional(),
        changedAt: z.coerce.date().optional(),
        clientSentAt: clientSentAtSchema,
      })
    )
    .output(z.object({ count: z.number(), counts: unreadCountsSchema.optional() }))
    .mutation(async ({ ctx, input }) => {
      const { clientSentAt, ...filters } = input;
      const { entryIds, counts } = await entryStateService.markAllEntriesRead(ctx.db, {
        ...filters,
        changedAt: toServerTime(input.changedAt, clientSentAt),
        userId: ctx.session.user.id,
        showSpam: ctx.session.user.showSpam,
      });

      return { count: entryIds.length, counts };
    }),

  /**
   * Set the starred status of an entry.
   *
   * The entry must be visible to the user (via user_entries).
   *
   * @param id - The entry ID to update
   * @param starred - Whether to star (true) or unstar (false)
   * @returns The updated entry with current state
   */
  setStarred: readerProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/entries/{id}/starred",
        tags: ["Entries"],
        summary: "Set entry starred status",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
        starred: z.boolean(),
        changedAt: z.coerce.date().optional(),
        clientSentAt: clientSentAtSchema,
      })
    )
    .output(setStarredOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      // updateEntryStarred computes the absolute counts and publishes the
      // entry_state_changed SSE event itself (so every caller — tRPC, MCP, and
      // the Google Reader/Wallabag compat routes — notifies other tabs).
      const { entry, counts } = await entryStateService.updateEntryStarred(
        ctx.db,
        userId,
        input.id,
        input.starred,
        toServerTime(input.changedAt, input.clientSentAt)
      );

      return { entry, counts };
    }),

  /**
   * Star or unstar entries in bulk, each with its own change time, with the
   * same last-write-wins semantics as markRead.
   */
  setStarredMany: appProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/entries/starred",
        tags: ["Entries"],
        summary: "Star/unstar entries",
      },
    })
    .input(
      z.object({
        entries: stateChangeEntriesSchema,
        starred: z.boolean(),
        clientSentAt: clientSentAtSchema,
      })
    )
    .output(bulkStateChangeOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const { entries, counts } = await entryStateService.updateEntriesStarred(
        ctx.db,
        ctx.session.user.id,
        input.entries.map((entry) => ({
          id: entry.id,
          changedAt: toServerTime(entry.changedAt, input.clientSentAt, now),
        })),
        input.starred
      );
      return { success: true, count: entries.length, entries, counts };
    }),

  /**
   * Fetch full article content from URL.
   *
   * This mutation fetches the full article from the entry's URL,
   * processes it through Readability, and stores both the original
   * and cleaned versions.
   *
   * On success, it also invalidates any existing narration content
   * so that it will be regenerated using the full content.
   *
   * @param id - The entry ID to fetch full content for
   * @returns The updated entry with full content fields
   */
  fetchFullContent: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/entries/{id}/fetch-full-content",
        tags: ["Entries"],
        summary: "Fetch full article content",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(
      z.object({
        success: z.boolean(),
        entry: entryFullSchema.optional(),
        error: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      return fullContentService.fetchAndStoreFullContent(ctx.db, userId, input.id);
    }),
});
