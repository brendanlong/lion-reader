/**
 * Shared Event Schemas
 *
 * Zod schemas for all sync event types used by both SSE and polling sync.
 * These replace manual typeof checks in the SSE parser and manual TypeScript
 * interfaces in the event handler.
 *
 * The server may include extra fields (userId, feedId) that aren't needed
 * client-side. Using passthrough() on the discriminated union allows those
 * fields to pass through without validation errors while we extract only
 * what the client needs via the schema definitions.
 */

import { z } from "zod";

// ============================================================================
// Shared Sub-schemas
// ============================================================================

const feedTypeSchema = z.enum(["web", "email", "saved"]);

const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});

const entryMetadataSchema = z.object({
  title: z.string().nullable(),
  author: z.string().nullable(),
  summary: z.string().nullable(),
  url: z.string().nullable(),
  publishedAt: z.string().nullable(),
});

const subscriptionDataSchema = z.object({
  id: z.string(),
  feedId: z.string(),
  customTitle: z.string().nullable(),
  subscribedAt: z.string(),
  unreadCount: z.number(),
  totalCount: z.number(),
  tags: z.array(tagSchema),
});

const feedDataSchema = z.object({
  id: z.string(),
  type: feedTypeSchema,
  url: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  siteUrl: z.string().nullable(),
});

// ============================================================================
// Base Fields
// ============================================================================

/**
 * Default timestamp generator for events that may not include a timestamp.
 */
const defaultTimestamp = () => new Date().toISOString();

// ============================================================================
// Individual Event Schemas
// ============================================================================

const newEntryEventSchema = z
  .object({
    type: z.literal("new_entry"),
    subscriptionId: z.string().nullable(),
    entryId: z.string(),
    timestamp: z.string().default(defaultTimestamp),
    updatedAt: z.string(),
    feedType: feedTypeSchema.optional(),
  })
  .passthrough();

const entryUpdatedEventSchema = z
  .object({
    type: z.literal("entry_updated"),
    subscriptionId: z.string().nullable(),
    entryId: z.string(),
    timestamp: z.string().default(defaultTimestamp),
    updatedAt: z.string(),
    metadata: entryMetadataSchema,
  })
  .passthrough();

const entryStateChangedEventSchema = z
  .object({
    type: z.literal("entry_state_changed"),
    entryId: z.string(),
    read: z.boolean(),
    starred: z.boolean(),
    /** Subscription ID for count delta computation (null for saved/orphaned entries) */
    subscriptionId: z.string().nullable().optional(),
    /** Previous read state before this change (absent in sync polling events) */
    previousRead: z.boolean().optional(),
    /** Previous starred state before this change (absent in sync polling events) */
    previousStarred: z.boolean().optional(),
    timestamp: z.string().default(defaultTimestamp),
    updatedAt: z.string(),
  })
  .passthrough();

const subscriptionCreatedEventSchema = z
  .object({
    type: z.literal("subscription_created"),
    subscriptionId: z.string(),
    feedId: z.string(),
    timestamp: z.string().default(defaultTimestamp),
    updatedAt: z.string(),
    subscription: subscriptionDataSchema,
    feed: feedDataSchema,
  })
  .passthrough();

const subscriptionDeletedEventSchema = z
  .object({
    type: z.literal("subscription_deleted"),
    subscriptionId: z.string(),
    timestamp: z.string().default(defaultTimestamp),
    updatedAt: z.string(),
  })
  .passthrough();

const tagCreatedEventSchema = z
  .object({
    type: z.literal("tag_created"),
    tag: tagSchema,
    timestamp: z.string().default(defaultTimestamp),
    updatedAt: z.string(),
  })
  .passthrough();

const tagUpdatedEventSchema = z
  .object({
    type: z.literal("tag_updated"),
    tag: tagSchema,
    timestamp: z.string().default(defaultTimestamp),
    updatedAt: z.string(),
  })
  .passthrough();

const tagDeletedEventSchema = z
  .object({
    type: z.literal("tag_deleted"),
    tagId: z.string(),
    timestamp: z.string().default(defaultTimestamp),
    updatedAt: z.string(),
  })
  .passthrough();

/**
 * Import events use `timestamp` as fallback for `updatedAt` since
 * the server doesn't always include `updatedAt` for import events.
 */
const importProgressEventSchema = z
  .object({
    type: z.literal("import_progress"),
    importId: z.string(),
    feedUrl: z.string(),
    feedStatus: z.enum(["imported", "skipped", "failed"]),
    imported: z.number(),
    skipped: z.number(),
    failed: z.number(),
    total: z.number(),
    timestamp: z.string().default(defaultTimestamp),
    updatedAt: z.string().optional(),
  })
  .passthrough()
  .transform((event) => ({
    ...event,
    updatedAt: event.updatedAt ?? event.timestamp,
  }));

const importCompletedEventSchema = z
  .object({
    type: z.literal("import_completed"),
    importId: z.string(),
    imported: z.number(),
    skipped: z.number(),
    failed: z.number(),
    total: z.number(),
    timestamp: z.string().default(defaultTimestamp),
    updatedAt: z.string().optional(),
  })
  .passthrough()
  .transform((event) => ({
    ...event,
    updatedAt: event.updatedAt ?? event.timestamp,
  }));

// ============================================================================
// Discriminated Union
// ============================================================================

/**
 * Schema for all sync events. Used to validate SSE event data and
 * derive the SyncEvent TypeScript type.
 *
 * Note: We use z.union instead of z.discriminatedUnion because some
 * member schemas use .transform(), which is not supported by
 * discriminatedUnion.
 */
export const syncEventSchema = z.union([
  newEntryEventSchema,
  entryUpdatedEventSchema,
  entryStateChangedEventSchema,
  subscriptionCreatedEventSchema,
  subscriptionDeletedEventSchema,
  tagCreatedEventSchema,
  tagUpdatedEventSchema,
  tagDeletedEventSchema,
  importProgressEventSchema,
  importCompletedEventSchema,
]);

// ============================================================================
// Inferred Types
// ============================================================================

/**
 * Union type for all sync events, inferred from the Zod schema.
 */
export type SyncEvent = z.infer<typeof syncEventSchema>;

/**
 * Individual event types for consumers that need to narrow on specific events.
 */
export type NewEntryEvent = z.infer<typeof newEntryEventSchema>;
export type EntryUpdatedEvent = z.infer<typeof entryUpdatedEventSchema>;
export type EntryStateChangedEvent = z.infer<typeof entryStateChangedEventSchema>;
export type SubscriptionCreatedEvent = z.infer<typeof subscriptionCreatedEventSchema>;
export type SubscriptionDeletedEvent = z.infer<typeof subscriptionDeletedEventSchema>;
export type TagCreatedEvent = z.infer<typeof tagCreatedEventSchema>;
export type TagUpdatedEvent = z.infer<typeof tagUpdatedEventSchema>;
export type TagDeletedEvent = z.infer<typeof tagDeletedEventSchema>;
export type ImportProgressEvent = z.infer<typeof importProgressEventSchema>;
export type ImportCompletedEvent = z.infer<typeof importCompletedEventSchema>;
