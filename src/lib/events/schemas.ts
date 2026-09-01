/**
 * Shared SSE/Sync Event Schemas
 *
 * Zod schemas for all real-time event types — the single declaration of each
 * event's shape. Every event type is defined once as a *base* schema
 * (server-canonical: strict timestamps, no client fallbacks), and every wire
 * derives from the bases:
 *
 * - `serverSyncEventSchema` (sync.events output validation) uses them directly
 * - `syncEventSchema` (client-side SSE/sync parsing) adds client leniency
 *   (timestamp defaults, updatedAt fallbacks)
 * - the Redis pub/sub wire schemas in `src/server/redis/pubsub.ts` extend them
 *   with routing fields (`userId`, `feedId`)
 * - the SSE route constructs its outgoing events as `ServerSyncEvent` values,
 *   so the objects it sends are type-checked against these schemas
 *
 * Adding a field to an event means editing its base schema here (and, if the
 * field is server-routing-only, the pubsub extension) — nothing else.
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
 * insert the entry into cached entries.list pages without a refetch. Extends
 * entryMetadataSchema (the entry_updated payload) with the extra list fields.
 *
 * `read`/`starred` are omitted on the live SSE path (a brand-new entry is
 * always unread/unstarred) but set by the sync.events catch-up path, where the
 * entry may have been read or starred on another device while this client was
 * offline. Consumers must treat absence as false.
 */
export const newEntryListDataSchema = entryMetadataSchema.extend({
  fetchedAt: z.string(),
  siteName: z.string().nullable(),
  feedTitle: z.string().nullable(),
  read: z.boolean().optional(),
  starred: z.boolean().optional(),
});

export type NewEntryListData = z.infer<typeof newEntryListDataSchema>;

/**
 * Entry-row fields toNewEntryListData reads. Matches both the drizzle Entry
 * row shape and hand-built insert values (optional fields are coerced to
 * null), so every publish site derives the payload from the row it already
 * holds instead of hand-assembling it.
 */
export interface NewEntryListDataSource {
  url?: string | null;
  title?: string | null;
  author?: string | null;
  summary?: string | null;
  publishedAt?: Date | null;
  fetchedAt: Date;
  siteName?: string | null;
}

/**
 * Builds the new_entry list payload from an entry row. The single place that
 * maps row fields (and Date → ISO string) for this event, shared by the feed
 * worker, email ingestion, saved articles, and the sync.events catch-up path.
 */
export function toNewEntryListData(
  entry: NewEntryListDataSource,
  feedTitle: string | null,
  state?: { read: boolean; starred: boolean }
): NewEntryListData {
  return {
    url: entry.url ?? null,
    title: entry.title ?? null,
    author: entry.author ?? null,
    summary: entry.summary ?? null,
    publishedAt: entry.publishedAt?.toISOString() ?? null,
    fetchedAt: entry.fetchedAt.toISOString(),
    siteName: entry.siteName ?? null,
    feedTitle,
    ...(state ? { read: state.read, starred: state.starred } : {}),
  };
}

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

/**
 * Announcement-banner levels. Also the source of truth for the server's
 * ANNOUNCEMENT_LEVELS (src/server/services/site-status.ts imports it), so the
 * wire schema and the admin validation can't drift.
 */
export const announcementLevels = ["info", "warning"] as const;

// ============================================================================
// Base Event Schemas (server-canonical, one per event type)
// ============================================================================

const feedTypeSchema = z.enum(["web", "email", "saved"]);

const newEntryEventBase = z.object({
  type: z.literal("new_entry"),
  subscriptionId: z.string().nullable(),
  entryId: z.string(),
  timestamp: z.string(),
  updatedAt: z.string(),
  feedType: feedTypeSchema,
  // Absolute unread counts, computed per-user at emit time. The client sets
  // these directly rather than applying a +1 delta, so a new_entry delivered
  // by both the live SSE stream and a reconnect catch-up sync can't
  // double-count. Optional because the SSE route omits them when the count
  // query fails (and on events from servers predating the field — deploy
  // window); when absent, counts are left untouched and self-heal on the next
  // count-bearing event or refetch.
  counts: unreadCountsSchema.optional(),
  // List-item data so the client can insert the entry into cached
  // entries.list pages directly. Optional for the deploy-window reason above;
  // when absent, the entry appears on the next list refresh
  // (navigation-triggered invalidation) instead of live.
  feedId: z.string().optional(),
  entry: newEntryListDataSchema.optional(),
});

const entryUpdatedEventBase = z.object({
  type: z.literal("entry_updated"),
  subscriptionId: z.string().nullable(),
  entryId: z.string(),
  timestamp: z.string(),
  updatedAt: z.string(),
  metadata: entryMetadataSchema,
});

const entryStateChangedEventBase = z.object({
  type: z.literal("entry_state_changed"),
  entryId: z.string(),
  read: z.boolean(),
  starred: z.boolean(),
  // Absolute unread counts from the server. The client sets these directly
  // instead of estimating deltas from cached state.
  counts: unreadCountsSchema,
  timestamp: z.string(),
  updatedAt: z.string(),
  // List-item data, present when the entry flipped to unread (and isn't spam),
  // so a client that doesn't have the entry in any cached list can insert it
  // into the lists it now belongs to — the same way new_entry payloads make
  // new entries appear live (issue #1237). Absent for entries becoming read
  // (nothing to insert) and on events from servers predating this field; the
  // client then falls back to restoring from another cached list's copy.
  subscriptionId: z.string().nullable().optional(),
  feedId: z.string().optional(),
  feedType: feedTypeSchema.optional(),
  entry: newEntryListDataSchema.optional(),
});

const markAllReadEventBase = z.object({
  type: z.literal("mark_all_read"),
  // Mark-all-read is unbounded, so instead of a per-entry event or a huge id
  // list, the server sends this single signal and the client invalidates its
  // entry lists + counts (see handleSyncEvent). `updatedAt` is the
  // mark-all-read timestamp, used to advance the entries cursor.
  timestamp: z.string(),
  updatedAt: z.string(),
  // The largest entry id among the marked rows: the entries keyset cursor
  // advances to (updatedAt, entryId), which skips every marked row in a
  // catch-up while still admitting an unrelated entry written in the same
  // millisecond (#1102). Absent on events from servers predating the field;
  // the client then falls back to skipping the whole tied-timestamp group.
  entryId: z.string().optional(),
});

const subscriptionCreatedEventBase = z.object({
  type: z.literal("subscription_created"),
  subscriptionId: z.string(),
  feedId: z.string(),
  timestamp: z.string(),
  updatedAt: z.string(),
  subscription: subscriptionCreatedDataSchema,
  feed: feedCreatedDataSchema,
  // Absolute unread counts for the lists the new (untagged) subscription
  // affects — All Articles, Uncategorized, and the subscription itself. The
  // client sets these directly instead of adding deltas. Optional so events
  // from servers predating this field still parse.
  counts: unreadCountsSchema.optional(),
});

const subscriptionDeletedEventBase = z.object({
  type: z.literal("subscription_deleted"),
  subscriptionId: z.string(),
  timestamp: z.string(),
  updatedAt: z.string(),
  // Absolute unread counts for the affected lists (All Articles + the
  // subscription's former tags / Uncategorized), computed at delete time. The
  // live mutation/SSE path includes these; the sync.events catch-up path can't
  // (the tag associations are already gone server-side), so it omits them and
  // the client falls back to invalidating tags.list + entries.count.
  counts: unreadCountsSchema.optional(),
});

const subscriptionUpdatedEventBase = z.object({
  type: z.literal("subscription_updated"),
  subscriptionId: z.string(),
  tags: z.array(syncTagSchema),
  customTitle: z.string().nullable(),
  timestamp: z.string(),
  updatedAt: z.string(),
});

const tagCreatedEventBase = z.object({
  type: z.literal("tag_created"),
  tag: syncTagSchema,
  timestamp: z.string(),
  updatedAt: z.string(),
});

const tagUpdatedEventBase = z.object({
  type: z.literal("tag_updated"),
  tag: syncTagSchema,
  timestamp: z.string(),
  updatedAt: z.string(),
});

const tagDeletedEventBase = z.object({
  type: z.literal("tag_deleted"),
  tagId: z.string(),
  timestamp: z.string(),
  updatedAt: z.string(),
});

// Import events carry no updatedAt on the wire (the client derives it from
// timestamp — see the client derivations below).
const importProgressEventBase = z.object({
  type: z.literal("import_progress"),
  importId: z.string(),
  feedUrl: z.string(),
  feedStatus: z.enum(["imported", "skipped", "failed"]),
  imported: z.number(),
  skipped: z.number(),
  failed: z.number(),
  total: z.number(),
  timestamp: z.string(),
});

const importCompletedEventBase = z.object({
  type: z.literal("import_completed"),
  importId: z.string(),
  imported: z.number(),
  skipped: z.number(),
  failed: z.number(),
  total: z.number(),
  timestamp: z.string(),
});

/**
 * Global announcement-banner change, broadcast on the site-status channel (not
 * per-user). `announcement` is null when the banner was disabled/cleared.
 */
const announcementChangedEventBase = z.object({
  type: z.literal("announcement_changed"),
  announcement: z
    .object({
      id: z.string(),
      message: z.string(),
      level: z.enum(announcementLevels),
    })
    .nullable(),
  timestamp: z.string(),
});

/**
 * Base schemas re-exported for the Redis pub/sub wire, which extends them with
 * routing fields (`userId`; `feedId` where the client form doesn't carry it).
 * See `src/server/redis/pubsub.ts`.
 */
export const eventBaseSchemas = {
  newEntry: newEntryEventBase,
  entryUpdated: entryUpdatedEventBase,
  entryStateChanged: entryStateChangedEventBase,
  markAllRead: markAllReadEventBase,
  subscriptionCreated: subscriptionCreatedEventBase,
  subscriptionDeleted: subscriptionDeletedEventBase,
  subscriptionUpdated: subscriptionUpdatedEventBase,
  tagCreated: tagCreatedEventBase,
  tagUpdated: tagUpdatedEventBase,
  tagDeleted: tagDeletedEventBase,
  importProgress: importProgressEventBase,
  importCompleted: importCompletedEventBase,
  announcementChanged: announcementChangedEventBase,
} as const;

// ============================================================================
// Client-Side Derivations (timestamp defaults, updatedAt fallbacks)
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

const clientTimestamp = { timestamp: timestampWithDefault };

/**
 * Discriminated union of the core events as the client parses them.
 *
 * Note: import and announcement events use .transform() for an updatedAt
 * fallback, so they can't be members of z.discriminatedUnion(). We use
 * z.union() with the discriminated union for the core events plus those.
 */
const coreEventSchema = z.discriminatedUnion("type", [
  newEntryEventBase.extend(clientTimestamp),
  entryUpdatedEventBase.extend(clientTimestamp),
  entryStateChangedEventBase.extend(clientTimestamp),
  markAllReadEventBase.extend(clientTimestamp),
  subscriptionCreatedEventBase.extend(clientTimestamp),
  subscriptionDeletedEventBase.extend(clientTimestamp),
  subscriptionUpdatedEventBase.extend(clientTimestamp),
  tagCreatedEventBase.extend(clientTimestamp),
  tagUpdatedEventBase.extend(clientTimestamp),
  tagDeletedEventBase.extend(clientTimestamp),
]);

/**
 * Adds the client-side updatedAt fallback for events whose wire form carries
 * no updatedAt (imports, announcement): cursor bookkeeping reads `updatedAt`
 * uniformly, so it defaults to `timestamp`.
 */
function withUpdatedAtFallback<T extends z.ZodObject<z.ZodRawShape>>(base: T) {
  return base.extend({ ...clientTimestamp, updatedAt: z.string().optional() }).transform(
    (
      event
    ): z.output<T> & {
      timestamp: string;
      updatedAt: string;
    } =>
      ({
        ...event,
        updatedAt: event.updatedAt ?? event.timestamp,
      }) as z.output<T> & { timestamp: string; updatedAt: string }
  );
}

const importProgressEventSchema = withUpdatedAtFallback(importProgressEventBase);
const importCompletedEventSchema = withUpdatedAtFallback(importCompletedEventBase);

/**
 * announcement_changed is kept out of `coreEventSchema`/`serverSyncEventSchema`
 * because it's an SSE-only global signal, not part of the per-user
 * entries/subscriptions/tags sync. Its `updatedAt` exists only to keep every
 * SyncEvent uniform (cursor bookkeeping reads `updatedAt`); this event never
 * advances a cursor.
 */
const announcementChangedEventSchema = withUpdatedAtFallback(announcementChangedEventBase);

export const syncEventSchema = z.union([
  coreEventSchema,
  importProgressEventSchema,
  importCompletedEventSchema,
  announcementChangedEventSchema,
]);

/**
 * The inferred TypeScript type for sync events.
 * Use this instead of manually maintaining interface types.
 */
export type SyncEvent = z.infer<typeof syncEventSchema>;

// ============================================================================
// Server-Only Event Schema (no defaults/transforms)
// ============================================================================

/**
 * Strict event schema used by the sync.events server endpoint — the base
 * schemas directly, since the server always provides timestamps.
 *
 * This excludes import events and mark_all_read, which are SSE-only (not
 * returned by sync.events).
 */
export const serverSyncEventSchema = z.discriminatedUnion("type", [
  newEntryEventBase,
  entryUpdatedEventBase,
  entryStateChangedEventBase,
  subscriptionCreatedEventBase,
  subscriptionDeletedEventBase,
  subscriptionUpdatedEventBase,
  tagCreatedEventBase,
  tagUpdatedEventBase,
  tagDeletedEventBase,
]);

/**
 * Server-side event type: what the SSE route and sync.events construct and
 * send. Building outgoing events as this type (rather than untyped JSON
 * literals) keeps them checked against the single event declaration above.
 */
export type ServerSyncEvent = z.infer<typeof serverSyncEventSchema>;
