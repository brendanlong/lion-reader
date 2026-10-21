/**
 * Shared SSE/Sync Event Schemas
 *
 * Zod schemas for all real-time event types. These are the single source of truth
 * for event shapes, used by:
 * - SSE event parsing (client-side)
 * - sync.events endpoint output validation (server-side)
 * - Cache event handlers (type derivation)
 *
 * SSE events from the server may include extra fields (userId) that
 * aren't relevant to the client. Using Zod's default strip behavior, these
 * extra fields are ignored during parsing.
 */

import { z } from "zod";
import { ENTRY_TYPES, SUBSCRIPTION_TYPES, type EntryType } from "@/lib/entry-types";

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
 * event's own entryId/subscriptionId/updatedAt) needed to
 * insert the entry into cached entries.list pages without a refetch. Extends
 * entryMetadataSchema (the entry_updated payload) with the extra list fields.
 *
 * `read`/`starred` are omitted from a feed's own announcement of a brand-new
 * entry (always unread/unstarred) but set wherever the user's row may predate
 * the event: the sync.events catch-up path (read or starred on another device
 * while this client was offline) and an entry a fetch linked to one subscriber
 * (`announceLinkedEntries`). Consumers must treat absence as false.
 */
export const newEntryListDataSchema = entryMetadataSchema.extend({
  // The entry's own type, for display only (a saved article shows its site
  // name); list membership comes from `subscriptionIds` (#1846).
  type: z.enum(ENTRY_TYPES),
  fetchedAt: z.string(),
  siteName: z.string().nullable(),
  feedTitle: z.string().nullable(),
  read: z.boolean().optional(),
  starred: z.boolean().optional(),
  // When read state last changed (Recently Read's order), with read/starred on
  // the catch-up path; null if it never has.
  readChangedAt: z.string().nullable().optional(),
  // The entry's own updated_at, when the event's `updatedAt` may be its user
  // state's (see `EntryRow.entryUpdatedAt`). Absent from a live new_entry,
  // whose `updatedAt` is already the entry's.
  entryUpdatedAt: z.string().optional(),
});

export type NewEntryListData = z.infer<typeof newEntryListDataSchema>;

/**
 * Entry-row fields toNewEntryListData reads. Matches both the drizzle Entry
 * row shape and hand-built insert values (optional fields are coerced to
 * null), so every publish site derives the payload from the row it already
 * holds instead of hand-assembling it.
 */
export interface NewEntryListDataSource {
  type: EntryType;
  url?: string | null;
  title?: string | null;
  author?: string | null;
  summary?: string | null;
  publishedAt?: Date | null;
  fetchedAt: Date;
  siteName?: string | null;
  entryUpdatedAt?: Date;
}

/**
 * Builds the new_entry list payload from an entry row. The single place that
 * maps row fields (and Date → ISO string) for this event, shared by the feed
 * worker, email ingestion, saved articles, and the sync.events catch-up path.
 */
export function toNewEntryListData(
  entry: NewEntryListDataSource,
  feedTitle: string | null,
  state?: { read: boolean; starred: boolean; readChangedAt?: Date | null }
): NewEntryListData {
  return {
    type: entry.type,
    url: entry.url ?? null,
    title: entry.title ?? null,
    author: entry.author ?? null,
    summary: entry.summary ?? null,
    publishedAt: entry.publishedAt?.toISOString() ?? null,
    fetchedAt: entry.fetchedAt.toISOString(),
    siteName: entry.siteName ?? null,
    feedTitle,
    ...(entry.entryUpdatedAt && { entryUpdatedAt: entry.entryUpdatedAt.toISOString() }),
    ...(state
      ? {
          read: state.read,
          starred: state.starred,
          ...(state.readChangedAt !== undefined
            ? { readChangedAt: state.readChangedAt?.toISOString() ?? null }
            : {}),
        }
      : {}),
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
 * When the server read a count: the start of the statement that read it
 * (every count is read after its write commits), as an ISO instant with
 * exactly six fractional digits so stamps compare as strings. The client keeps
 * the newest value for each list, so a response or event that arrives late
 * can't overwrite a newer count.
 */
export const countsAsOfSchema = z.string();

/**
 * Orders two `countsAsOfSchema` stamps; an unstamped value counts as newest.
 */
export function isCountsAsOfNewer(
  incoming: string | undefined,
  stored: string | undefined
): boolean {
  return incoming === undefined || stored === undefined || incoming >= stored;
}

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
  saved: z.object({ unread: z.number() }),
  // Only the affected subscriptions, each with its tags so a client can place
  // one it hasn't loaded.
  subscriptions: z.array(
    z.object({ id: z.string(), unread: z.number(), tagIds: z.array(z.string()) })
  ),
  // Only the affected tags.
  tags: z.array(z.object({ id: z.string(), unread: z.number() })),
  // Present when an affected subscription has no tags.
  uncategorized: z.object({ unread: z.number() }).optional(),
  asOf: countsAsOfSchema,
});

/**
 * A subscription as `subscriptions.get` returns it (`subscriptionSchema` in
 * `services/subscriptions.ts` is this with a `Date`), as the subscription
 * events carry it. Its id is the subscription's: clients never see feed ids.
 */
export const syncSubscriptionSchema = z.object({
  id: z.string(),
  type: z.enum(SUBSCRIPTION_TYPES),
  url: z.string().nullable(),
  /** The custom title if set, else the feed's. */
  title: z.string().nullable(),
  /** The feed's own title, for the rename UI. */
  originalTitle: z.string().nullable(),
  description: z.string().nullable(),
  siteUrl: z.string().nullable(),
  subscribedAt: z.string(),
  unreadCount: z.number(),
  /** When `unreadCount` was read. */
  unreadCountAsOf: countsAsOfSchema,
  /** Sorted by name, then id. */
  tags: z.array(syncTagSchema),
  /** Whether to fetch each entry's full article from its URL. */
  fetchFullContent: z.boolean(),
});

export type SyncSubscription = z.infer<typeof syncSubscriptionSchema>;

/**
 * A subscription event's `row`. Absent from a previous release's events, whose
 * subscription the client then fetches.
 */
const eventSubscriptionRowSchema = syncSubscriptionSchema.optional();

// What subscription events carried before `row`, for app builds that predate
// it: don't read these. `customTitle` is the row's title, which those builds
// show as `customTitle ?? feed.title`.
const deprecated = { deprecated: true };
const deprecatedCustomTitleSchema = z.string().nullable().meta(deprecated);
const deprecatedCreatedSubscriptionSchema = z
  .object({
    id: z.string(),
    customTitle: deprecatedCustomTitleSchema,
    subscribedAt: z.string(),
    unreadCount: z.number(),
    tags: z.array(syncTagSchema),
    fetchFullContent: z.boolean().optional(),
  })
  .meta(deprecated);
const deprecatedCreatedFeedSchema = z
  .object({
    type: z.enum(SUBSCRIPTION_TYPES),
    url: z.string().nullable(),
    title: z.string().nullable(),
    description: z.string().nullable(),
    siteUrl: z.string().nullable(),
  })
  .meta(deprecated);

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

/**
 * Every active subscription holding the entry (#1846): its origin
 * (`subscriptionId`), its collections and, for a saved article, the saved
 * subscription.
 */
const subscriptionIdsSchema = z.array(z.string());

/** An entry's position in each active collection that gives it one (#2064), by subscription id. */
export const entryPositionsSchema = z.record(z.string(), z.number());

export const newEntryEventSchema = z.object({
  type: z.literal("new_entry"),
  subscriptionId: z.string().nullable(),
  subscriptionIds: subscriptionIdsSchema,
  entryId: z.string(),
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
  // Absolute unread counts from the server, computed per-user at emit time.
  // The client sets these directly rather than applying a +1 delta, so a
  // new_entry delivered by both the live SSE stream and a reconnect catch-up
  // sync can't double-count. Absent when the server failed to read them;
  // counts are then left untouched and self-heal on the next count-bearing
  // event or refetch.
  counts: unreadCountsSchema.optional(),
  // List-item data so the client can insert the entry into cached
  // entries.list pages directly. Absent for spam, which the default
  // entries.list filters out.
  entry: newEntryListDataSchema.optional(),
});

/**
 * What a client places a new entry in its lists from: a new_entry event's
 * list fields. The mutation that created the entry returns it too, so the
 * acting tab needn't wait for the event.
 */
export const newEntryListItemSchema = newEntryEventSchema
  .pick({ entryId: true, subscriptionId: true, subscriptionIds: true, updatedAt: true })
  .extend({ entry: newEntryListDataSchema });

export type NewEntryListItem = z.infer<typeof newEntryListItemSchema>;

export const entryUpdatedEventSchema = z.object({
  type: z.literal("entry_updated"),
  subscriptionId: z.string().nullable(),
  entryId: z.string(),
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
  // The entry's own updated_at, set by the sync.events catch-up, whose
  // `updatedAt` is a cursor stamp that may be the user state's.
  entryUpdatedAt: z.string().optional(),
  metadata: entryMetadataSchema,
});

export const entryStateChangedEventSchema = z.object({
  type: z.literal("entry_state_changed"),
  entryId: z.string(),
  read: z.boolean(),
  starred: z.boolean(),
  // When read state last changed (Recently Read's order); null if it never
  // has. Set by the sync.events catch-up path; absent on the live SSE path.
  readChangedAt: z.string().nullable().optional(),
  // Absolute unread counts from the server. The client sets these directly
  // instead of estimating deltas from cached state.
  counts: unreadCountsSchema,
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
  // List-item data, present when the entry flipped to unread (and isn't spam),
  // so a client that doesn't have the entry in any cached list can insert it
  // into the lists it now belongs to — the same way new_entry payloads make
  // new entries appear live (issue #1237). Absent for entries becoming read
  // (nothing to insert), from star/unstar, for spam, and when the publisher's
  // lookup failed; the client then falls back to the stored row.
  subscriptionId: z.string().nullable().optional(),
  entry: newEntryListDataSchema.optional(),
  subscriptionIds: subscriptionIdsSchema,
  // The user's score and the entry's collection positions (#2064), which
  // travel with its state. Optional: a server a release behind sends neither.
  score: z.number().nullable().optional(),
  positions: entryPositionsSchema.optional(),
});

export const markAllReadEventSchema = z.object({
  type: z.literal("mark_all_read"),
  // Mark-all-read is unbounded, so instead of a per-entry event or a huge id
  // list, the server sends this single signal with the absolute counts, and
  // the client invalidates its entry lists (see handleSyncEvent). `updatedAt`
  // is the mark-all-read timestamp, used to advance the entries cursor.
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
  // The largest entry id among the marked rows: the entries keyset cursor
  // advances to (updatedAt, entryId), which skips every marked row in a
  // catch-up while still admitting an unrelated entry written in the same
  // millisecond (#1102).
  entryId: z.string(),
  counts: unreadCountsSchema,
});

export const subscriptionCreatedEventSchema = z.object({
  type: z.literal("subscription_created"),
  subscriptionId: z.string(),
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
  row: eventSubscriptionRowSchema,
  subscription: deprecatedCreatedSubscriptionSchema,
  feed: deprecatedCreatedFeedSchema,
  // Absolute unread counts for the lists the new (untagged) subscription
  // affects — All Articles, Uncategorized, and the subscription itself. The
  // client sets these directly instead of adding deltas. Absent when an email
  // creates the subscription and from the sync.events catch-up; the client
  // then invalidates the count caches.
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
  // the client falls back to invalidating tags.list + entries.countLists.
  counts: unreadCountsSchema.optional(),
});

export const subscriptionUpdatedEventSchema = z.object({
  type: z.literal("subscription_updated"),
  subscriptionId: z.string(),
  row: eventSubscriptionRowSchema,
  tags: z.array(syncTagSchema).meta(deprecated),
  customTitle: deprecatedCustomTitleSchema,
  fetchFullContent: z.boolean().optional().meta(deprecated),
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

// Articles added to or removed from a collection. SSE-only: delta sync
// re-delivers each changed entry through its user_entries.updated_at instead.
export const collectionEntriesChangedEventSchema = z.object({
  type: z.literal("collection_entries_changed"),
  subscriptionId: z.string(),
  entryIds: z.array(z.string()),
  added: z.boolean(),
  /** Added articles' positions in the collection, by entry id, for those that have one. */
  positions: z.record(z.string(), z.number()).optional(),
  counts: unreadCountsSchema,
  timestamp: timestampWithDefault,
  updatedAt: z.string(),
});

// Import and announcement events fill in `updatedAt` with a transform, so the
// server's Redis schemas extend these bases instead.
export const importProgressEventBaseSchema = z.object({
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
});

export const importCompletedEventBaseSchema = z.object({
  type: z.literal("import_completed"),
  importId: z.string(),
  imported: z.number(),
  skipped: z.number(),
  failed: z.number(),
  total: z.number(),
  timestamp: timestampWithDefault,
  updatedAt: updatedAtWithFallback,
});

function withUpdatedAtFallback<T extends { timestamp: string; updatedAt?: string }>(
  event: T
): T & { updatedAt: string } {
  return { ...event, updatedAt: event.updatedAt ?? event.timestamp };
}

const importProgressEventSchema = importProgressEventBaseSchema.transform(withUpdatedAtFallback);
const importCompletedEventSchema = importCompletedEventBaseSchema.transform(withUpdatedAtFallback);

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
  markAllReadEventSchema,
  subscriptionCreatedEventSchema,
  subscriptionDeletedEventSchema,
  subscriptionUpdatedEventSchema,
  tagCreatedEventSchema,
  tagUpdatedEventSchema,
  tagDeletedEventSchema,
  collectionEntriesChangedEventSchema,
]);

/**
 * The first event on every SSE stream, naming the build the server runs
 * (`BUILD_ID` in `src/lib/build-id.ts`). Not a sync event: it carries no
 * state and never advances a cursor.
 */
export const helloEventSchema = z.object({ buildId: z.string().optional() });

export const ANNOUNCEMENT_LEVELS = ["info", "warning"] as const;

/**
 * Global announcement-banner change, broadcast on the site-status channel (not
 * per-user). `announcement` is null when the banner was disabled/cleared. Kept
 * out of `coreEventSchema`/`serverSyncEventSchema` because it's an SSE-only
 * global signal, not part of the per-user entries/subscriptions/tags sync.
 */
export const announcementChangedEventBaseSchema = z.object({
  type: z.literal("announcement_changed"),
  announcement: z
    .object({
      id: z.string(),
      message: z.string(),
      level: z.enum(ANNOUNCEMENT_LEVELS),
    })
    .nullable(),
  timestamp: timestampWithDefault,
  // Carried only to keep every SyncEvent uniform (cursor bookkeeping reads
  // `updatedAt`); this event never advances a cursor. Defaults to `timestamp`.
  updatedAt: z.string().optional(),
});

const announcementChangedEventSchema =
  announcementChangedEventBaseSchema.transform(withUpdatedAtFallback);

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
// Each member is titled with its type so the OpenAPI breaking-change check
// matches a changed event to its old version rather than reporting it as a
// new member of the union.
export const serverSyncEventSchema = z.discriminatedUnion("type", [
  newEntryEventSchema.extend(strictTimestamp).meta({ title: "new_entry" }),
  entryUpdatedEventSchema.extend(strictTimestamp).meta({ title: "entry_updated" }),
  entryStateChangedEventSchema.extend(strictTimestamp).meta({ title: "entry_state_changed" }),
  subscriptionCreatedEventSchema.extend(strictTimestamp).meta({ title: "subscription_created" }),
  subscriptionDeletedEventSchema.extend(strictTimestamp).meta({ title: "subscription_deleted" }),
  subscriptionUpdatedEventSchema.extend(strictTimestamp).meta({ title: "subscription_updated" }),
  tagCreatedEventSchema.extend(strictTimestamp).meta({ title: "tag_created" }),
  tagUpdatedEventSchema.extend(strictTimestamp).meta({ title: "tag_updated" }),
  tagDeletedEventSchema.extend(strictTimestamp).meta({ title: "tag_deleted" }),
]);
