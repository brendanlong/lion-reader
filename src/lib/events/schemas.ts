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
 * Tag data included in tag events.
 */
export const syncTagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
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
  feedType: z.enum(["web", "email", "saved"]).optional(),
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
});

export const subscriptionDeletedEventSchema = z.object({
  type: z.literal("subscription_deleted"),
  subscriptionId: z.string(),
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
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
