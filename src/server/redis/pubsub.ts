/**
 * Redis Pub/Sub module for real-time event publishing and subscribing.
 *
 * Publishing: events are published when entries are created/updated and when
 * user-scoped state changes (subscriptions, tags, read/starred state, imports).
 *
 * Subscribing: the SSE endpoint consumes events via createPubSubSubscription,
 * which multiplexes all subscriptions in this process over a single shared
 * Redis connection with reference-counted channels and in-process fan-out.
 */

import Redis from "ioredis";
import { z } from "zod";
import { getRedisClient } from "@/server/redis";
import {
  entryMetadataSchema,
  newEntryListDataSchema,
  syncTagSchema,
  subscriptionCreatedDataSchema,
  feedCreatedDataSchema,
  legacyFeedId,
  unreadCountsSchema,
  type NewEntryListData,
} from "@/lib/events/schemas";
import { ANNOUNCEMENT_LEVELS, type Announcement } from "@/server/services/site-status";
import { toEntryMetadata } from "@/server/services/entry-sync-events";
import type { BulkUnreadCounts } from "@/server/services/counts";

// ============================================================================
// Event Schemas (single source of truth for both publishing and parsing)
// ============================================================================

/**
 * Zod schema for web feed events published/received via Redis pub/sub.
 * Reuses entryMetadataSchema from the shared event schemas.
 */
const feedEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("new_entry"),
    feedId: z.string(),
    entryId: z.string(),
    timestamp: z.string(),
    updatedAt: z.string(),
    feedType: z.literal("web"),
    // List-item data forwarded to clients so they can insert the entry into
    // cached lists. Optional so events published by a previous release (no
    // entry data) still parse during a deploy window.
    entry: newEntryListDataSchema.optional(),
  }),
  z.object({
    type: z.literal("entry_updated"),
    feedId: z.string(),
    entryId: z.string(),
    timestamp: z.string(),
    updatedAt: z.string(),
    metadata: entryMetadataSchema,
  }),
]);

/**
 * Zod schema for user events published/received via Redis pub/sub.
 * Composes from shared sub-schemas (syncTagSchema, subscriptionCreatedDataSchema, etc.)
 * to stay in sync with the client-side event definitions.
 */
const userEventSchema = z.discriminatedUnion("type", [
  // Entry events for sources with exactly one recipient (email, saved), which
  // go to that user's channel instead of a feed channel. They carry what the
  // SSE route adds to a web feed's events itself: the user's subscriptionId
  // (null for saved articles).
  z.object({
    type: z.literal("new_entry"),
    userId: z.string(),
    subscriptionId: z.string().nullable(),
    entryId: z.string(),
    timestamp: z.string(),
    updatedAt: z.string(),
    feedType: z.enum(["email", "saved"]),
    entry: newEntryListDataSchema.optional(),
  }),
  z.object({
    type: z.literal("entry_updated"),
    userId: z.string(),
    subscriptionId: z.string().nullable(),
    entryId: z.string(),
    timestamp: z.string(),
    updatedAt: z.string(),
    feedType: z.enum(["email", "saved"]),
    metadata: entryMetadataSchema,
  }),
  z.object({
    type: z.literal("subscription_created"),
    userId: z.string(),
    // The feed channel to follow; null for a subscription without a feed (#1846).
    feedId: z.string().nullable(),
    subscriptionId: z.string(),
    timestamp: z.string(),
    updatedAt: z.string(),
    subscription: subscriptionCreatedDataSchema,
    feed: feedCreatedDataSchema,
    counts: unreadCountsSchema.optional(),
  }),
  z.object({
    type: z.literal("subscription_updated"),
    userId: z.string(),
    subscriptionId: z.string(),
    tags: z.array(syncTagSchema),
    customTitle: z.string().nullable(),
    timestamp: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("subscription_deleted"),
    userId: z.string(),
    feedId: z.string().nullable(),
    subscriptionId: z.string(),
    timestamp: z.string(),
    updatedAt: z.string(),
    counts: unreadCountsSchema.optional(),
  }),
  z.object({
    type: z.literal("import_progress"),
    userId: z.string(),
    importId: z.string(),
    feedUrl: z.string(),
    feedStatus: z.enum(["imported", "skipped", "failed"]),
    imported: z.number(),
    skipped: z.number(),
    failed: z.number(),
    total: z.number(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal("import_completed"),
    userId: z.string(),
    importId: z.string(),
    imported: z.number(),
    skipped: z.number(),
    failed: z.number(),
    total: z.number(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal("entry_state_changed"),
    userId: z.string(),
    entryId: z.string(),
    read: z.boolean(),
    starred: z.boolean(),
    counts: unreadCountsSchema,
    timestamp: z.string(),
    updatedAt: z.string(),
    // List-item data, attached when the entry flipped to unread (and isn't
    // spam), so clients can insert it into cached lists it's missing from —
    // mirroring the new_entry payload (issue #1237).
    subscriptionId: z.string().nullable().optional(),
    feedType: z.enum(["web", "email", "saved"]).optional(),
    entry: newEntryListDataSchema.optional(),
    // Every active subscription holding the entry (#1846).
    subscriptionIds: z.array(z.string()).optional(),
  }),
  // Mark-all-read signal. Mark-all-read is unbounded, so instead of shipping
  // every affected id (or one entry_state_changed per entry, which would storm
  // every connection), we publish a single event with the absolute counts and
  // let each client invalidate its entry lists. `updatedAt` is the mark-all-read
  // timestamp, used to advance the entries sync cursor so a reconnect catch-up
  // doesn't re-deliver every marked entry.
  z.object({
    type: z.literal("mark_all_read"),
    userId: z.string(),
    timestamp: z.string(),
    updatedAt: z.string(),
    // The largest entry id among the marked rows. The client advances its
    // entries keyset cursor to (updatedAt, entryId): every marked row sorts at
    // or below it (no catch-up re-delivery), while an unrelated entry written
    // in the same millisecond — whose UUIDv7 id sorts above every
    // earlier-created marked entry — stays past the cursor, so a catch-up can
    // still deliver it (#1102).
    entryId: z.string(),
    // Absent from a previous release's events.
    counts: unreadCountsSchema.optional(),
  }),
  z.object({
    type: z.literal("tag_created"),
    userId: z.string(),
    tag: syncTagSchema,
    timestamp: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("tag_updated"),
    userId: z.string(),
    tag: syncTagSchema,
    timestamp: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("tag_deleted"),
    userId: z.string(),
    tagId: z.string(),
    timestamp: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    type: z.literal("collection_entries_changed"),
    userId: z.string(),
    subscriptionId: z.string(),
    entryIds: z.array(z.string()),
    added: z.boolean(),
    counts: unreadCountsSchema,
    timestamp: z.string(),
    updatedAt: z.string(),
  }),
]);

/**
 * Zod schema for the global site-status events channel. Currently just the
 * announcement banner: a single broadcast channel (not per-user) so an admin
 * change reaches every connected client. Kept a discriminated union so more
 * global signals can be added later.
 */
const siteStatusEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("announcement_changed"),
    // The active announcement (with its message-derived id), or null when it
    // was disabled/cleared so clients hide the banner.
    announcement: z
      .object({
        id: z.string(),
        message: z.string(),
        level: z.enum(ANNOUNCEMENT_LEVELS),
      })
      .nullable(),
    timestamp: z.string(),
  }),
]);

/** Union type for all site-status events. */
export type SiteStatusEvent = z.infer<typeof siteStatusEventSchema>;

// ============================================================================
// Derived Types (all derived from Zod schemas above)
// ============================================================================

/** Union type for all feed events. */
export type FeedEvent = z.infer<typeof feedEventSchema>;
/** Union type for all user events. */
export type UserEvent = z.infer<typeof userEventSchema>;

// Sub-types derived from shared schemas
export type EntryUpdatedMetadata = z.infer<typeof entryMetadataSchema>;
type SubscriptionCreatedEventSubscription = Omit<
  z.infer<typeof subscriptionCreatedDataSchema>,
  "id" | "feedId"
>;
type SubscriptionCreatedEventFeed = Omit<z.infer<typeof feedCreatedDataSchema>, "id">;

/**
 * Returns the channel name for feed-specific events.
 * Each web feed has its own channel so one publish reaches every subscriber,
 * and servers only receive events for feeds their connected users are
 * subscribed to. Email and saved entries have a single recipient and go to
 * the user's channel instead.
 *
 * @param feedId - The feed's ID
 * @returns The channel name for the feed's events
 */
export function getFeedEventsChannel(feedId: string): string {
  return `feed:${feedId}:events`;
}

/**
 * Returns the channel name for user-specific events.
 * Each user has their own channel so only their sessions receive the events.
 *
 * @param userId - The user's ID
 * @returns The channel name for the user's events
 */
export function getUserEventsChannel(userId: string): string {
  return `user:${userId}:events`;
}

/**
 * Returns the name of the single global site-status channel. Not scoped to a
 * user — every SSE connection subscribes to it so an admin's announcement change
 * is broadcast to all clients (ref-counted on the shared subscriber, so it's one
 * Redis SUBSCRIBE per process regardless of connection count).
 */
export function getSiteStatusChannel(): string {
  return "site-status:events";
}

/**
 * Publishes an event to a Redis channel. Every `publish*` function below funnels
 * through here: they own the typed signature and the event shape, this owns the
 * client lookup, serialization, and the Redis-unavailable no-op.
 *
 * @param channel - The channel to publish on
 * @param event - The event to publish
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
async function publishToChannel(
  channel: string,
  event: FeedEvent | UserEvent | SiteStatusEvent
): Promise<number> {
  // Published on the shared main client: PUBLISH is an ordinary command, so it
  // needs no dedicated connection (only SUBSCRIBE mode does — see
  // getSharedSubscriberClient).
  const client = getRedisClient();
  if (!client) {
    return 0;
  }
  return client.publish(channel, JSON.stringify(event));
}

// Each event scope derives its own channel from the event, so a user event can't
// be published to a feed's channel (which every subscriber of that feed reads)
// by passing the wrong channel name. See SECURITY.md on cross-user isolation.

/** Publishes a feed event to its feed's channel. */
async function publishFeedEvent(event: FeedEvent): Promise<number> {
  return publishToChannel(getFeedEventsChannel(event.feedId), event);
}

/** Publishes a user event to that user's channel. */
async function publishUserEvent(event: UserEvent): Promise<number> {
  return publishToChannel(getUserEventsChannel(event.userId), event);
}

/** Publishes an event to the single global site-status channel. */
async function publishSiteStatusEvent(event: SiteStatusEvent): Promise<number> {
  return publishToChannel(getSiteStatusChannel(), event);
}

/**
 * Publishes a new_entry event for a web feed's entry on the feed's channel.
 * Email and saved entries use publishUserNewEntry.
 *
 * @param feedId - The ID of the feed containing the entry
 * @param entryId - The ID of the newly created entry
 * @param updatedAt - The database updated_at timestamp for cursor tracking
 * @param entry - List-item data so clients can insert the entry into cached
 *   lists. Pass undefined for entries the default entries.list would filter
 *   out (spam) so clients only update counts and never insert a ghost row.
 * @returns The number of subscribers that received the message
 */
export async function publishNewEntry(
  feedId: string,
  entryId: string,
  updatedAt: Date,
  entry: NewEntryListData | undefined
): Promise<number> {
  return publishFeedEvent({
    type: "new_entry",
    feedId,
    entryId,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
    feedType: "web",
    ...(entry ? { entry } : {}),
  });
}

/** Where an email or saved entry's events go: its one recipient. */
interface UserEntryTarget {
  userId: string;
  /** The email subscription's id, or the saved subscription's (null when not looked up). */
  subscriptionId: string | null;
  feedType: "email" | "saved";
}

/**
 * Publishes a new_entry event for an email or saved entry on its user's
 * channel (no other user can receive it, so no feed channel is needed).
 *
 * @param target - The entry's recipient and source
 * @param entryId - The ID of the newly created entry
 * @param updatedAt - The database updated_at timestamp for cursor tracking
 * @param entry - List-item data, as for publishNewEntry (undefined for spam)
 * @returns The number of the user's subscribers that received the message
 */
export async function publishUserNewEntry(
  target: UserEntryTarget,
  entryId: string,
  updatedAt: Date,
  entry: NewEntryListData | undefined
): Promise<number> {
  return publishUserEvent({
    type: "new_entry",
    userId: target.userId,
    subscriptionId: target.subscriptionId,
    entryId,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
    feedType: target.feedType,
    ...(entry ? { entry } : {}),
  });
}

/**
 * Publishes an entry_updated event for an email or saved entry on its user's
 * channel. See publishUserNewEntry.
 *
 * @param target - The entry's recipient and source
 * @param entry - The entry object (from database)
 * @returns The number of the user's subscribers that received the message
 */
export async function publishUserEntryUpdated(
  target: UserEntryTarget,
  entry: EntryLike
): Promise<number> {
  return publishUserEvent({
    type: "entry_updated",
    userId: target.userId,
    subscriptionId: target.subscriptionId,
    entryId: entry.id,
    timestamp: new Date().toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    feedType: target.feedType,
    metadata: toEntryMetadata(entry),
  });
}

/**
 * Publishes an entry_updated event when an entry content changes.
 *
 * @param feedId - The ID of the feed containing the entry
 * @param entryId - The ID of the updated entry
 * @param updatedAt - The database updated_at timestamp for cursor tracking
 * @param metadata - Entry metadata for direct cache updates
 * @returns The number of subscribers that received the message
 */
async function publishEntryUpdated(
  feedId: string,
  entryId: string,
  updatedAt: Date,
  metadata: EntryUpdatedMetadata
): Promise<number> {
  return publishFeedEvent({
    type: "entry_updated",
    feedId,
    entryId,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
    metadata,
  });
}

/**
 * Entry-like object with fields needed for publishing update events.
 * Matches the Entry type from the database schema.
 */
interface EntryLike {
  id: string;
  title: string | null;
  author: string | null;
  summary: string | null;
  url: string | null;
  publishedAt: Date | null;
  updatedAt: Date;
}

/**
 * Convenience function to publish an entry_updated event from an Entry object.
 * Extracts metadata from the entry automatically.
 *
 * @param feedId - The ID of the feed containing the entry
 * @param entry - The entry object (from database)
 * @returns The number of subscribers that received the message
 */
export async function publishEntryUpdatedFromEntry(
  feedId: string,
  entry: EntryLike
): Promise<number> {
  return publishEntryUpdated(feedId, entry.id, entry.updatedAt, toEntryMetadata(entry));
}

/**
 * Publishes a subscription_created event when a user subscribes to a feed.
 * This notifies all of the user's SSE connections to:
 * 1. Add the new feedId to their filter set (so they receive new_entry events for it)
 * 2. Update the subscriptions cache directly with the provided data
 *
 * @param userId - The ID of the user who subscribed
 * @param feedId - The ID of the feed they subscribed to (server-side routing only; null without a feed)
 * @param subscriptionId - The ID of the new subscription
 * @param updatedAt - The database updated_at timestamp for cursor tracking
 * @param subscription - Subscription data for optimistic cache update
 * @param feed - Feed data for optimistic cache update
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishSubscriptionCreated(
  userId: string,
  feedId: string | null,
  subscriptionId: string,
  updatedAt: Date,
  subscription: SubscriptionCreatedEventSubscription,
  feed: SubscriptionCreatedEventFeed,
  counts?: z.infer<typeof unreadCountsSchema>
): Promise<number> {
  return publishUserEvent({
    type: "subscription_created",
    userId,
    feedId,
    subscriptionId,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
    subscription: { ...subscription, id: subscriptionId, feedId: legacyFeedId(subscriptionId) },
    feed: { ...feed, id: legacyFeedId(subscriptionId) },
    counts,
  });
}

/**
 * Publishes a collection_entries_changed event after articles are added to or
 * removed from a collection, so the user's other tabs update its counts.
 */
export async function publishCollectionEntriesChanged(
  userId: string,
  subscriptionId: string,
  entryIds: string[],
  added: boolean,
  updatedAt: Date,
  counts: z.infer<typeof unreadCountsSchema>
): Promise<number> {
  return publishUserEvent({
    type: "collection_entries_changed",
    userId,
    subscriptionId,
    entryIds,
    added,
    counts,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
  });
}

/**
 * Publishes a subscription_deleted event when a user unsubscribes from a feed.
 * This notifies all of the user's SSE connections to:
 * 1. Remove the feedId from their filter set (so they stop receiving new_entry events for it)
 * 2. Refresh the subscriptions list in the UI
 *
 * @param userId - The ID of the user who unsubscribed
 * @param feedId - The ID of the feed they unsubscribed from (null without a feed)
 * @param subscriptionId - The ID of the subscription that was deleted
 * @param updatedAt - The database updated_at timestamp for cursor tracking
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishSubscriptionDeleted(
  userId: string,
  feedId: string | null,
  subscriptionId: string,
  updatedAt: Date,
  counts?: z.infer<typeof unreadCountsSchema>
): Promise<number> {
  return publishUserEvent({
    type: "subscription_deleted",
    userId,
    feedId,
    subscriptionId,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
    counts,
  });
}

/**
 * Publishes a subscription_updated event when a subscription's properties change.
 * This notifies all of the user's SSE connections to update their subscription caches.
 *
 * @param userId - The ID of the user who owns the subscription
 * @param subscriptionId - The ID of the updated subscription
 * @param updatedAt - The database updated_at timestamp for cursor tracking
 * @param tags - The subscription's current tags
 * @param customTitle - The subscription's custom title (null for default)
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishSubscriptionUpdated(
  userId: string,
  subscriptionId: string,
  updatedAt: Date,
  tags: Array<{ id: string; name: string; color: string | null }>,
  customTitle: string | null
): Promise<number> {
  return publishUserEvent({
    type: "subscription_updated",
    userId,
    subscriptionId,
    tags,
    customTitle,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
  });
}

/**
 * Publishes an import_progress event when a feed in an OPML import is processed.
 * This notifies the user's SSE connections to update the import progress UI.
 *
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishImportProgress(
  userId: string,
  importId: string,
  feedUrl: string,
  feedStatus: "imported" | "skipped" | "failed",
  counts: { imported: number; skipped: number; failed: number; total: number }
): Promise<number> {
  return publishUserEvent({
    type: "import_progress",
    userId,
    importId,
    feedUrl,
    feedStatus,
    imported: counts.imported,
    skipped: counts.skipped,
    failed: counts.failed,
    total: counts.total,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Publishes an import_completed event when an OPML import finishes.
 * This notifies the user's SSE connections that the import is done.
 *
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishImportCompleted(
  userId: string,
  importId: string,
  counts: { imported: number; skipped: number; failed: number; total: number }
): Promise<number> {
  return publishUserEvent({
    type: "import_completed",
    userId,
    importId,
    imported: counts.imported,
    skipped: counts.skipped,
    failed: counts.failed,
    total: counts.total,
    timestamp: new Date().toISOString(),
  });
}

/**
 * List-item context for an entry_state_changed event, attached when the entry
 * flipped to unread so clients can insert it into cached lists it's missing
 * from (issue #1237). See publishMarkReadStateChanges for where it's built.
 */
export interface EntryStateListData {
  subscriptionId: string | null;
  feedType: "web" | "email" | "saved";
  entry: NewEntryListData;
}

/**
 * Publishes an entry_state_changed event when read/starred state changes.
 * This notifies all of the user's SSE connections for multi-tab/device sync.
 *
 * @param userId - The ID of the user whose entry state changed
 * @param entryId - The ID of the entry
 * @param read - Current read state
 * @param starred - Current starred state
 * @param updatedAt - The database updated_at timestamp for cursor tracking
 * @param counts - Absolute unread counts for all affected lists
 * @param listData - List-item context, present when the entry flipped to unread
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishEntryStateChanged(
  userId: string,
  entryId: string,
  read: boolean,
  starred: boolean,
  updatedAt: Date,
  counts: z.infer<typeof unreadCountsSchema>,
  listData?: EntryStateListData,
  subscriptionIds?: string[]
): Promise<number> {
  return publishUserEvent({
    type: "entry_state_changed",
    userId,
    entryId,
    read,
    starred,
    counts,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
    ...(listData ?? {}),
    ...(subscriptionIds ? { subscriptionIds } : {}),
  });
}

/**
 * Publishes a mark_all_read signal after a bulk mark-all-read.
 *
 * Unlike markRead (which publishes one entry_state_changed per entry),
 * mark-all-read is unbounded, so a per-entry fan-out would storm every one of
 * the user's connections and shipping every affected id could mean a huge
 * payload. Instead this single signal carries the absolute counts and tells
 * each connection to invalidate its entry lists — the same thing the acting
 * tab does on success.
 *
 * @param userId - The ID of the user whose entries were marked read
 * @param updatedAt - The mark-all-read timestamp, used to advance the entries
 *   sync cursor so a reconnect catch-up doesn't re-deliver every marked entry
 * @param maxEntryId - The largest entry id among the marked rows; together with
 *   `updatedAt` it forms the exact keyset position past the marked rows, so the
 *   cursor doesn't also skip an unrelated entry written in the same
 *   millisecond (#1102)
 * @param counts - Absolute counts for every list the marked entries reached
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishMarkAllRead(
  userId: string,
  updatedAt: Date,
  maxEntryId: string,
  counts: BulkUnreadCounts
): Promise<number> {
  return publishUserEvent({
    type: "mark_all_read",
    userId,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
    entryId: maxEntryId,
    counts,
  });
}

/**
 * Publishes a tag_created event when a tag is created.
 *
 * @param userId - The ID of the user who created the tag
 * @param tag - The tag data
 * @param updatedAt - The database updated_at timestamp for cursor tracking
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishTagCreated(
  userId: string,
  tag: { id: string; name: string; color: string | null },
  updatedAt: Date
): Promise<number> {
  return publishUserEvent({
    type: "tag_created",
    userId,
    tag,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
  });
}

/**
 * Publishes a tag_updated event when a tag is updated.
 *
 * @param userId - The ID of the user who updated the tag
 * @param tag - The updated tag data
 * @param updatedAt - The database updated_at timestamp for cursor tracking
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishTagUpdated(
  userId: string,
  tag: { id: string; name: string; color: string | null },
  updatedAt: Date
): Promise<number> {
  return publishUserEvent({
    type: "tag_updated",
    userId,
    tag,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
  });
}

/**
 * Publishes a tag_deleted event when a tag is deleted.
 *
 * @param userId - The ID of the user who deleted the tag
 * @param tagId - The ID of the deleted tag
 * @param updatedAt - The database updated_at timestamp for cursor tracking
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishTagDeleted(
  userId: string,
  tagId: string,
  updatedAt: Date
): Promise<number> {
  return publishUserEvent({
    type: "tag_deleted",
    userId,
    tagId,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
  });
}

/**
 * Publishes an announcement_changed event to the global site-status channel
 * when an admin changes the announcement banner. Pass the resolved announcement
 * (with its id) or null when it was disabled/cleared.
 *
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishAnnouncementChanged(
  announcement: Announcement | null
): Promise<number> {
  return publishSiteStatusEvent({
    type: "announcement_changed",
    announcement,
    timestamp: new Date().toISOString(),
  });
}

// ============================================================================
// Shared Subscriber (one Redis connection per process, in-process fan-out)
// ============================================================================

/** Callback invoked with every message received on a subscribed channel. */
type ChannelMessageListener = (channel: string, message: string) => void;

interface ChannelState {
  listeners: Set<ChannelMessageListener>;
  /** Resolves when the Redis-level SUBSCRIBE for this channel completes. */
  ready: Promise<void>;
}

let sharedSubscriberClient: Redis | null = null;
let sharedSubscriberInitialized = false;
const channelStates = new Map<string, ChannelState>();

/**
 * Gets or creates the shared Redis subscriber connection for this process.
 * Redis requires a dedicated connection for SUBSCRIBE mode, but one connection
 * can hold any number of channel subscriptions, so all consumers in the
 * process (e.g. every SSE connection) share this single client instead of
 * opening one connection each.
 */
function getSharedSubscriberClient(): Redis | null {
  if (sharedSubscriberInitialized) {
    return sharedSubscriberClient;
  }

  sharedSubscriberInitialized = true;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    return null;
  }

  const client = new Redis(redisUrl, {
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
  });

  client.on("message", (channel: string, message: string) => {
    const state = channelStates.get(channel);
    if (!state) return;
    for (const listener of state.listeners) {
      try {
        listener(channel, message);
      } catch (err) {
        console.error(`Pub/sub listener error on channel ${channel}:`, err);
      }
    }
  });

  client.on("error", (err) => {
    // ioredis reconnects automatically and re-subscribes to all channels
    console.error("Redis shared subscriber error:", err);
  });

  sharedSubscriberClient = client;
  return client;
}

/**
 * Adds a listener for a channel, issuing the Redis-level SUBSCRIBE only for
 * the first listener. Resolves once the channel subscription is active.
 */
async function addChannelListener(
  client: Redis,
  channel: string,
  listener: ChannelMessageListener
): Promise<void> {
  const existing = channelStates.get(channel);
  if (existing) {
    existing.listeners.add(listener);
    try {
      await existing.ready;
    } catch (err) {
      existing.listeners.delete(listener);
      throw err;
    }
    return;
  }

  const state: ChannelState = {
    listeners: new Set([listener]),
    ready: client.subscribe(channel).then(() => undefined),
  };
  channelStates.set(channel, state);
  try {
    await state.ready;
  } catch (err) {
    // Drop the failed state so a later subscribe attempt retries the SUBSCRIBE
    if (channelStates.get(channel) === state) {
      channelStates.delete(channel);
    }
    throw err;
  }
}

/**
 * Removes a listener for a channel, issuing the Redis-level UNSUBSCRIBE when
 * the last listener is removed.
 */
function removeChannelListener(channel: string, listener: ChannelMessageListener): void {
  const state = channelStates.get(channel);
  if (!state) return;

  state.listeners.delete(listener);
  if (state.listeners.size === 0) {
    channelStates.delete(channel);
    sharedSubscriberClient?.unsubscribe(channel).catch((err) => {
      console.error(`Failed to unsubscribe from channel ${channel}:`, err);
    });
  }
}

/**
 * A per-consumer handle onto the shared subscriber. Tracks which channels the
 * consumer is subscribed to so they can be released individually or all at
 * once via close().
 */
export interface PubSubSubscription {
  /** Subscribes this handle's listener to the given channels. */
  subscribe(...channels: string[]): Promise<void>;
  /** Unsubscribes this handle's listener from the given channels. */
  unsubscribe(...channels: string[]): void;
  /** Releases all channels held by this handle. The handle cannot be reused. */
  close(): void;
}

/**
 * Creates a pub/sub subscription backed by the single shared Redis subscriber
 * connection for this process. Channel subscriptions are reference-counted
 * across handles and messages are fanned out in-process, so N concurrent
 * consumers (e.g. SSE connections) cost one Redis connection instead of N.
 *
 * @param onMessage - Called for every message on a channel this handle subscribed to
 * @returns A subscription handle, or null if Redis is not configured
 */
export function createPubSubSubscription(
  onMessage: ChannelMessageListener
): PubSubSubscription | null {
  const client = getSharedSubscriberClient();
  if (!client) {
    return null;
  }

  const ownChannels = new Set<string>();
  let closed = false;

  const unsubscribe = (...channels: string[]): void => {
    for (const channel of channels) {
      if (!ownChannels.delete(channel)) continue;
      removeChannelListener(channel, onMessage);
    }
  };

  return {
    async subscribe(...channels: string[]): Promise<void> {
      if (closed) return;

      const added = channels.filter((channel) => !ownChannels.has(channel));
      for (const channel of added) {
        ownChannels.add(channel);
      }

      const results = await Promise.allSettled(
        added.map((channel) => addChannelListener(client, channel, onMessage))
      );

      let firstError: unknown = null;
      results.forEach((result, i) => {
        if (result.status === "rejected") {
          ownChannels.delete(added[i]);
          firstError ??= result.reason;
        }
      });
      if (firstError !== null) {
        throw firstError;
      }
    },
    unsubscribe,
    close(): void {
      if (closed) return;
      closed = true;
      unsubscribe(...ownChannels);
    },
  };
}

/** Builds a parser for one channel's JSON messages; returns null for anything malformed. */
function eventParser<T>(schema: z.ZodType<T>): (message: string) => T | null {
  return (message) => {
    try {
      const result = schema.safeParse(JSON.parse(message));
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  };
}

export const parseFeedEvent = eventParser(feedEventSchema);
export const parseUserEvent = eventParser(userEventSchema);
export const parseSiteStatusEvent = eventParser(siteStatusEventSchema);

/**
 * Checks if Redis is available and responding.
 * Uses a PING command with a timeout to verify connectivity.
 *
 * @param timeoutMs - Maximum time to wait for response (default: 2000ms)
 * @returns true if Redis is healthy, false otherwise (including if not configured)
 */
export async function checkRedisHealth(timeoutMs = 2000): Promise<boolean> {
  try {
    const client = getRedisClient();

    // If Redis is not configured, return false
    if (!client) {
      return false;
    }

    // Race between ping and timeout
    const pingPromise = client.ping();
    const timeoutPromise = new Promise<null>((_, reject) => {
      setTimeout(() => reject(new Error("Redis health check timeout")), timeoutMs);
    });

    const result = await Promise.race([pingPromise, timeoutPromise]);
    return result === "PONG";
  } catch {
    return false;
  }
}
