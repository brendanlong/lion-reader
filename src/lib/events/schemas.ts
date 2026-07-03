/**
 * Shared SSE/Sync Event Schemas
 *
 * Zod schemas for all real-time event types. These are the single source of truth
 * for event shapes, used by:
 * - SSE event parsing (client-side)
 * - sync.events endpoint output validation (server-side)
 * - Cache event handlers (type derivation)
 *
 * SSE events from the server may include extra fields (userId, feedId) that
 * aren't relevant to the client. Using Zod's default strip behavior, these
 * extra fields are ignored during parsing.
 */

import { z } from "zod";

// ============================================================================
// Reusable Sub-Schemas
// ============================================================================

/**
 * Entry metadata for entry_updated events.
 */
export const entryMetadataSchema = z.object({
  title: z.string().nullable(),
  author: z.string().nullable(),
  summary: z.string().nullable(),
  url: z.string().nullable(),
  publishedAt: z.string().nullable(),
});

/**
 * Entry list-item data for new_entry events. Carries everything (beyond the
 * event's own entryId/subscriptionId/feedId/feedType/updatedAt) needed to
 * insert the entry into cached entries.list pages without a refetch. Mirrors
 * the per-feed fields of entryListItemSchema; a new entry is always
 * read=false/starred=false, so per-user state isn't included.
 */
export const newEntryListDataSchema = z.object({
  url: z.string().nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  summary: z.string().nullable(),
  publishedAt: z.string().nullable(),
  fetchedAt: z.string(),
  siteName: z.string().nullable(),
  feedTitle: z.string().nullable(),
});

export type NewEntryListData = z.infer<typeof newEntryListDataSchema>;

/**
 * Tag data included in tag events.
 */
export const syncTagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});

/**
 * Absolute unread counts included in count-affecting events (new_entry,
 * entry_state_changed). The client sets these directly from the server
 * instead of estimating deltas from cached state, which makes the events
 * idempotent — applying the same event twice (e.g. once from the live SSE
 * stream and once from a reconnect catch-up sync) leaves counts correct.
 */
export const unreadCountsSchema = z.object({
  all: z.object({ unread: z.number() }),
  starred: z.object({ unread: z.number() }),
  saved: z.object({ unread: z.number() }).optional(),
  subscriptions: z.array(z.object({ id: z.string(), unread: z.number() })),
  tags: z.array(z.object({ id: z.string(), unread: z.number() })),
  uncategorized: z.object({ unread: z.number() }).optional(),
});

/**
 * Subscription data for subscription_created events.
 */
export const subscriptionCreatedDataSchema = z.object({
  id: z.string(),
  feedId: z.string(),
  customTitle: z.string().nullable(),
  subscribedAt: z.string(),
  unreadCount: z.number(),
  tags: z.array(syncTagSchema),
});

/**
 * Feed data for subscription_created events.
 */
export const feedCreatedDataSchema = z.object({
  id: z.string(),
  type: z.enum(["web", "email", "saved"]),
  url: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  siteUrl: z.string().nullable(),
});

// ============================================================================
// Timestamp Helpers
// ============================================================================

/**
 * Timestamp field that defaults to current time if not provided by the server.
 * SSE events from Redis pub/sub always include timestamps, but this provides
 * a safe fallback.
 */
const timestampWithDefault = z
  .string()
  .optional()
  .default(() => new Date().toISOString());

/**
 * updatedAt field that falls back to timestamp if not provided.
 * Import events don't always include updatedAt from the server.
 */
const updatedAtWithFallback = z.string().optional();

// ============================================================================
// Individual Event Schemas
// ============================================================================

export const newEntryEventSchema = z.object({
  type: z.literal("new_entry"),
  subscriptionId: z.string().nullable(),
  entryId: z.string(),
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
  feedType: z.enum(["web", "email", "saved"]),
  // Absolute unread counts from the server, computed per-user at emit time.
  // The client sets these directly rather than applying a +1 delta, so a
  // new_entry delivered by both the live SSE stream and a reconnect catch-up
  // sync can't double-count. Optional only so events from servers predating
  // this field (deploy window) still parse; when absent, counts are left
  // untouched and self-heal on the next count-bearing event or refetch.
  counts: unreadCountsSchema.optional(),
  // List-item data so the client can insert the entry into cached
  // entries.list pages directly. Optional for the same deploy-window reason
  // as counts; when absent, the entry appears on the next list refresh
  // (navigation-triggered invalidation) instead of live.
  feedId: z.string().optional(),
  entry: newEntryListDataSchema.optional(),
});

export const entryUpdatedEventSchema = z.object({
  type: z.literal("entry_updated"),
  subscriptionId: z.string().nullable(),
  entryId: z.string(),
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
  metadata: entryMetadataSchema,
});

export const entryStateChangedEventSchema = z.object({
  type: z.literal("entry_state_changed"),
  entryId: z.string(),
  read: z.boolean(),
  starred: z.boolean(),
  // Absolute unread counts from the server. The client sets these directly
  // instead of estimating deltas from cached state.
  counts: unreadCountsSchema,
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
});

export const subscriptionCreatedEventSchema = z.object({
  type: z.literal("subscription_created"),
  subscriptionId: z.string(),
  feedId: z.string(),
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
  subscription: subscriptionCreatedDataSchema,
  feed: feedCreatedDataSchema,
  // Absolute unread counts for the lists the new (untagged) subscription
  // affects — All Articles, Uncategorized, and the subscription itself. The
  // client sets these directly instead of adding deltas. Optional so events
  // from servers predating this field still parse.
  counts: unreadCountsSchema.optional(),
});

export const subscriptionDeletedEventSchema = z.object({
  type: z.literal("subscription_deleted"),
  subscriptionId: z.string(),
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
  // Absolute unread counts for the affected lists (All Articles + the
  // subscription's former tags / Uncategorized), computed at delete time. The
  // live mutation/SSE path includes these; the sync.events catch-up path can't
  // (the tag associations are already gone server-side), so it omits them and
  // the client falls back to invalidating tags.list + entries.count.
  counts: unreadCountsSchema.optional(),
});

export const subscriptionUpdatedEventSchema = z.object({
  type: z.literal("subscription_updated"),
  subscriptionId: z.string(),
  tags: z.array(syncTagSchema),
  customTitle: z.string().nullable(),
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
});

export const tagCreatedEventSchema = z.object({
  type: z.literal("tag_created"),
  tag: syncTagSchema,
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
});

export const tagUpdatedEventSchema = z.object({
  type: z.literal("tag_updated"),
  tag: syncTagSchema,
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
});

export const tagDeletedEventSchema = z.object({
  type: z.literal("tag_deleted"),
  tagId: z.string(),
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
});

export const importProgressEventSchema = z
  .object({
    type: z.literal("import_progress"),
    importId: z.string(),
    feedUrl: z.string(),
    feedStatus: z.enum(["imported", "skipped", "failed"]),
    imported: z.number(),
    skipped: z.number(),
    failed: z.number(),
    total: z.number(),
    timestamp: timestampWithDefault,
    updatedAt: updatedAtWithFallback,
  })
  .transform((event) => ({
    ...event,
    updatedAt: event.updatedAt ?? event.timestamp,
  }));

export const importCompletedEventSchema = z
  .object({
    type: z.literal("import_completed"),
    importId: z.string(),
    imported: z.number(),
    skipped: z.number(),
    failed: z.number(),
    total: z.number(),
    timestamp: timestampWithDefault,
    updatedAt: updatedAtWithFallback,
  })
  .transform((event) => ({
    ...event,
    updatedAt: event.updatedAt ?? event.timestamp,
  }));

// ============================================================================
// Unified Event Schema
// ============================================================================

/**
 * Discriminated union of all SSE/sync event types.
 *
 * Note: import events use .transform() for updatedAt fallback, so they can't
 * be members of z.discriminatedUnion(). We use z.union() with the discriminated
 * union for the core events plus the import events.
 */
const coreEventSchema = z.discriminatedUnion("type", [
  newEntryEventSchema,
  entryUpdatedEventSchema,
  entryStateChangedEventSchema,
  subscriptionCreatedEventSchema,
  subscriptionDeletedEventSchema,
  subscriptionUpdatedEventSchema,
  tagCreatedEventSchema,
  tagUpdatedEventSchema,
  tagDeletedEventSchema,
]);

export const syncEventSchema = z.union([
  coreEventSchema,
  importProgressEventSchema,
  importCompletedEventSchema,
]);

/**
 * The inferred TypeScript type for sync events.
 * Use this instead of manually maintaining interface types.
 */
export type SyncEvent = z.infer<typeof syncEventSchema>;

// ============================================================================
// Server-Only Event Schema (without defaults/transforms)
// ============================================================================

/**
 * Strict event schema used by the sync.events server endpoint.
 * Derived from the client-side schemas by overriding `timestamp` to require
 * a string (no default), since the server always provides timestamps.
 *
 * This also excludes import events which are SSE-only (not returned by sync.events).
 */
const strictTimestamp = { timestamp: z.string() };
export const serverSyncEventSchema = z.discriminatedUnion("type", [
  newEntryEventSchema.extend(strictTimestamp),
  entryUpdatedEventSchema.extend(strictTimestamp),
  entryStateChangedEventSchema.extend(strictTimestamp),
  subscriptionCreatedEventSchema.extend(strictTimestamp),
  subscriptionDeletedEventSchema.extend(strictTimestamp),
  subscriptionUpdatedEventSchema.extend(strictTimestamp),
  tagCreatedEventSchema.extend(strictTimestamp),
  tagUpdatedEventSchema.extend(strictTimestamp),
  tagDeletedEventSchema.extend(strictTimestamp),
]);
