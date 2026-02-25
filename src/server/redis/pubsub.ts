/**
 * Redis Pub/Sub module for real-time event publishing.
 *
 * This module provides event publishing capabilities for the feed system.
 * Events are published when new entries are created or existing entries are updated.
 *
 * The subscriber side (SSE endpoint) will be implemented in phase 6.2.
 */

import Redis from "ioredis";
import { z } from "zod";
import {
  entryMetadataSchema,
  syncTagSchema,
  subscriptionCreatedDataSchema,
  feedCreatedDataSchema,
} from "@/lib/events/schemas";

// ============================================================================
// Event Schemas (single source of truth for both publishing and parsing)
// ============================================================================

/**
 * Zod schema for feed events published/received via Redis pub/sub.
 * Reuses entryMetadataSchema from the shared event schemas.
 */
const feedEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("new_entry"),
    feedId: z.string(),
    entryId: z.string(),
    timestamp: z.string(),
    updatedAt: z.string(),
    feedType: z.enum(["web", "email", "saved"]).optional(),
  }),
  z.object({
    type: z.literal("entry_updated"),
    feedId: z.string(),
    entryId: z.string(),
    timestamp: z.string(),
    updatedAt: z.string(),
    feedType: z.enum(["web", "email", "saved"]).optional(),
    metadata: entryMetadataSchema,
  }),
]);

/**
 * Zod schema for user events published/received via Redis pub/sub.
 * Composes from shared sub-schemas (syncTagSchema, subscriptionCreatedDataSchema, etc.)
 * to stay in sync with the client-side event definitions.
 */
const userEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("subscription_created"),
    userId: z.string(),
    feedId: z.string(),
    subscriptionId: z.string(),
    timestamp: z.string(),
    updatedAt: z.string(),
    subscription: subscriptionCreatedDataSchema,
    feed: feedCreatedDataSchema,
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
    feedId: z.string(),
    subscriptionId: z.string(),
    timestamp: z.string(),
    updatedAt: z.string(),
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
    timestamp: z.string(),
    updatedAt: z.string(),
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
]);

// ============================================================================
// Derived Types (all derived from Zod schemas above)
// ============================================================================

/** Union type for all feed events. */
export type FeedEvent = z.infer<typeof feedEventSchema>;
/** Union type for all user events. */
export type UserEvent = z.infer<typeof userEventSchema>;

// Individual feed event types (used by publish functions)
type NewEntryEvent = Extract<FeedEvent, { type: "new_entry" }>;
type EntryUpdatedEvent = Extract<FeedEvent, { type: "entry_updated" }>;

// Sub-types derived from shared schemas
export type EntryUpdatedMetadata = z.infer<typeof entryMetadataSchema>;
export type SubscriptionCreatedEventSubscription = z.infer<typeof subscriptionCreatedDataSchema>;
export type SubscriptionCreatedEventFeed = z.infer<typeof feedCreatedDataSchema>;

// Individual user event types (used by publish functions)
type SubscriptionCreatedEvent = Extract<UserEvent, { type: "subscription_created" }>;
type SubscriptionUpdatedEvent = Extract<UserEvent, { type: "subscription_updated" }>;
type SubscriptionDeletedEvent = Extract<UserEvent, { type: "subscription_deleted" }>;
type ImportProgressEvent = Extract<UserEvent, { type: "import_progress" }>;
type ImportCompletedEvent = Extract<UserEvent, { type: "import_completed" }>;
type EntryStateChangedEvent = Extract<UserEvent, { type: "entry_state_changed" }>;
type TagCreatedEvent = Extract<UserEvent, { type: "tag_created" }>;
type TagUpdatedEvent = Extract<UserEvent, { type: "tag_updated" }>;
type TagDeletedEvent = Extract<UserEvent, { type: "tag_deleted" }>;

/**
 * Returns the channel name for feed-specific events.
 * Each feed has its own channel so servers only receive events for feeds
 * their connected users are subscribed to.
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
 * Dedicated Redis client for publishing events.
 * Using a separate client is recommended by Redis documentation for pub/sub operations.
 * This is a singleton that gets created lazily on first use.
 */
let publisherClient: Redis | null = null;
let publisherInitialized = false;

/**
 * Gets or creates the Redis publisher client.
 * Uses lazy initialization to avoid connection issues during module load.
 *
 * @returns Redis client configured for publishing, or null if Redis is not configured
 */
function getPublisherClient(): Redis | null {
  if (publisherInitialized) {
    return publisherClient;
  }

  publisherInitialized = true;
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    return null;
  }

  publisherClient = new Redis(redisUrl, {
    // Reconnect with exponential backoff
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    // Use lazy connect to avoid blocking on startup
    lazyConnect: true,
  });

  // Log connection events in development
  if (process.env.NODE_ENV === "development") {
    publisherClient.on("connect", () => {
      console.log("Redis publisher connected");
    });

    publisherClient.on("error", (err) => {
      console.error("Redis publisher error:", err);
    });
  }

  return publisherClient;
}

/**
 * Publishes a feed event to the feed-specific Redis channel.
 *
 * @param event - The event to publish
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
async function publishFeedEvent(event: FeedEvent): Promise<number> {
  const client = getPublisherClient();
  if (!client) {
    return 0;
  }
  const channel = getFeedEventsChannel(event.feedId);
  const message = JSON.stringify(event);
  return client.publish(channel, message);
}

/**
 * Publishes a new_entry event when an entry is created.
 *
 * @param feedId - The ID of the feed containing the entry
 * @param entryId - The ID of the newly created entry
 * @param updatedAt - The database updated_at timestamp for cursor tracking
 * @param feedType - The feed type (web, email, or saved)
 * @returns The number of subscribers that received the message
 */
export async function publishNewEntry(
  feedId: string,
  entryId: string,
  updatedAt: Date,
  feedType?: "web" | "email" | "saved"
): Promise<number> {
  const event: NewEntryEvent = {
    type: "new_entry",
    feedId,
    entryId,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
    feedType,
  };
  return publishFeedEvent(event);
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
  const event: EntryUpdatedEvent = {
    type: "entry_updated",
    feedId,
    entryId,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
    metadata,
  };
  return publishFeedEvent(event);
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
  return publishEntryUpdated(feedId, entry.id, entry.updatedAt, {
    title: entry.title,
    author: entry.author,
    summary: entry.summary,
    url: entry.url,
    publishedAt: entry.publishedAt?.toISOString() ?? null,
  });
}

/**
 * Publishes a subscription_created event when a user subscribes to a feed.
 * This notifies all of the user's SSE connections to:
 * 1. Add the new feedId to their filter set (so they receive new_entry events for it)
 * 2. Update the subscriptions cache directly with the provided data
 *
 * @param userId - The ID of the user who subscribed
 * @param feedId - The ID of the feed they subscribed to
 * @param subscriptionId - The ID of the new subscription
 * @param updatedAt - The database updated_at timestamp for cursor tracking
 * @param subscription - Full subscription data for optimistic cache update
 * @param feed - Full feed data for optimistic cache update
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishSubscriptionCreated(
  userId: string,
  feedId: string,
  subscriptionId: string,
  updatedAt: Date,
  subscription: SubscriptionCreatedEventSubscription,
  feed: SubscriptionCreatedEventFeed
): Promise<number> {
  const client = getPublisherClient();
  if (!client) {
    return 0;
  }
  const event: SubscriptionCreatedEvent = {
    type: "subscription_created",
    userId,
    feedId,
    subscriptionId,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
    subscription,
    feed,
  };
  const channel = getUserEventsChannel(userId);
  return client.publish(channel, JSON.stringify(event));
}

/**
 * Publishes a subscription_deleted event when a user unsubscribes from a feed.
 * This notifies all of the user's SSE connections to:
 * 1. Remove the feedId from their filter set (so they stop receiving new_entry events for it)
 * 2. Refresh the subscriptions list in the UI
 *
 * @param userId - The ID of the user who unsubscribed
 * @param feedId - The ID of the feed they unsubscribed from
 * @param subscriptionId - The ID of the subscription that was deleted
 * @param updatedAt - The database updated_at timestamp for cursor tracking
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishSubscriptionDeleted(
  userId: string,
  feedId: string,
  subscriptionId: string,
  updatedAt: Date
): Promise<number> {
  const client = getPublisherClient();
  if (!client) {
    return 0;
  }
  const event: SubscriptionDeletedEvent = {
    type: "subscription_deleted",
    userId,
    feedId,
    subscriptionId,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
  const channel = getUserEventsChannel(userId);
  return client.publish(channel, JSON.stringify(event));
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
  const client = getPublisherClient();
  if (!client) {
    return 0;
  }
  const event: SubscriptionUpdatedEvent = {
    type: "subscription_updated",
    userId,
    subscriptionId,
    tags,
    customTitle,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
  const channel = getUserEventsChannel(userId);
  return client.publish(channel, JSON.stringify(event));
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
  const client = getPublisherClient();
  if (!client) {
    return 0;
  }
  const event: ImportProgressEvent = {
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
  };
  const channel = getUserEventsChannel(userId);
  return client.publish(channel, JSON.stringify(event));
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
  const client = getPublisherClient();
  if (!client) {
    return 0;
  }
  const event: ImportCompletedEvent = {
    type: "import_completed",
    userId,
    importId,
    imported: counts.imported,
    skipped: counts.skipped,
    failed: counts.failed,
    total: counts.total,
    timestamp: new Date().toISOString(),
  };
  const channel = getUserEventsChannel(userId);
  return client.publish(channel, JSON.stringify(event));
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
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishEntryStateChanged(
  userId: string,
  entryId: string,
  read: boolean,
  starred: boolean,
  updatedAt: Date
): Promise<number> {
  const client = getPublisherClient();
  if (!client) {
    return 0;
  }
  const event: EntryStateChangedEvent = {
    type: "entry_state_changed",
    userId,
    entryId,
    read,
    starred,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
  const channel = getUserEventsChannel(userId);
  return client.publish(channel, JSON.stringify(event));
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
  const client = getPublisherClient();
  if (!client) {
    return 0;
  }
  const event: TagCreatedEvent = {
    type: "tag_created",
    userId,
    tag,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
  const channel = getUserEventsChannel(userId);
  return client.publish(channel, JSON.stringify(event));
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
  const client = getPublisherClient();
  if (!client) {
    return 0;
  }
  const event: TagUpdatedEvent = {
    type: "tag_updated",
    userId,
    tag,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
  const channel = getUserEventsChannel(userId);
  return client.publish(channel, JSON.stringify(event));
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
  const client = getPublisherClient();
  if (!client) {
    return 0;
  }
  const event: TagDeletedEvent = {
    type: "tag_deleted",
    userId,
    tagId,
    timestamp: new Date().toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
  const channel = getUserEventsChannel(userId);
  return client.publish(channel, JSON.stringify(event));
}

/**
 * Creates a new Redis client for subscribing to feed events.
 * Each subscriber should use its own connection as Redis requires
 * dedicated connections for subscriptions.
 *
 * @returns A new Redis client configured for subscribing, or null if Redis is not configured
 */
export function createSubscriberClient(): Redis | null {
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

  if (process.env.NODE_ENV === "development") {
    client.on("connect", () => {
      console.log("Redis subscriber connected");
    });

    client.on("error", (err) => {
      console.error("Redis subscriber error:", err);
    });
  }

  return client;
}

/**
 * Parses a JSON message from the feed events channel.
 *
 * @param message - The JSON string message from Redis
 * @returns The parsed FeedEvent or null if parsing fails
 */
export function parseFeedEvent(message: string): FeedEvent | null {
  try {
    const result = feedEventSchema.safeParse(JSON.parse(message));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Parses a JSON message from a user events channel.
 *
 * @param message - The JSON string message from Redis
 * @returns The parsed UserEvent or null if parsing fails
 */
export function parseUserEvent(message: string): UserEvent | null {
  try {
    const result = userEventSchema.safeParse(JSON.parse(message));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Checks if Redis is available and responding.
 * Uses a PING command with a timeout to verify connectivity.
 *
 * @param timeoutMs - Maximum time to wait for response (default: 2000ms)
 * @returns true if Redis is healthy, false otherwise (including if not configured)
 */
export async function checkRedisHealth(timeoutMs = 2000): Promise<boolean> {
  try {
    const client = getPublisherClient();

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
