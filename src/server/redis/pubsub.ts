/**
 * Redis Pub/Sub module for real-time event publishing.
 *
 * This module provides event publishing capabilities for the feed system.
 * Events are published when new entries are created or existing entries are updated.
 *
 * The subscriber side (SSE endpoint) will be implemented in phase 6.2.
 */

import Redis from "ioredis";

/**
 * Event types that can be published.
 */
type FeedEventType = "new_entry" | "entry_updated";

/**
 * Base event payload interface for feed events.
 */
interface BaseFeedEvent {
  type: FeedEventType;
  feedId: string;
  entryId: string;
  timestamp: string;
  feedType?: "web" | "email" | "saved"; // Added to new_entry for cache updates
}

/**
 * Event published when a new entry is created.
 */
export interface NewEntryEvent extends BaseFeedEvent {
  type: "new_entry";
}

/**
 * Event published when an existing entry is updated.
 */
export interface EntryUpdatedEvent extends BaseFeedEvent {
  type: "entry_updated";
}

/**
 * Union type for all feed events.
 */
export type FeedEvent = NewEntryEvent | EntryUpdatedEvent;

/**
 * Subscription data included in subscription_created events.
 * Mirrors the subscription output schema to enable optimistic cache updates.
 */
export interface SubscriptionCreatedEventSubscription {
  id: string;
  feedId: string;
  customTitle: string | null;
  subscribedAt: string; // ISO string for serialization
  unreadCount: number;
  tags: Array<{ id: string; name: string; color: string | null }>;
}

/**
 * Feed data included in subscription_created events.
 * Mirrors the feed output schema to enable optimistic cache updates.
 */
export interface SubscriptionCreatedEventFeed {
  id: string;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  description: string | null;
  siteUrl: string | null;
}

/**
 * Event published when a user subscribes to a new feed.
 * This is sent to all of the user's active SSE connections so they can:
 * 1. Add the new feedId to their filter set
 * 2. Update the subscriptions cache directly (optimistic update)
 *
 * Includes full subscription and feed data to enable cache updates without
 * requiring a full refetch of the subscriptions list.
 */
export interface SubscriptionCreatedEvent {
  type: "subscription_created";
  userId: string;
  feedId: string;
  subscriptionId: string;
  timestamp: string;
  /** Full subscription data for optimistic cache update */
  subscription: SubscriptionCreatedEventSubscription;
  /** Full feed data for optimistic cache update */
  feed: SubscriptionCreatedEventFeed;
}

/**
 * Event published when a user unsubscribes from a feed.
 * This is sent to all of the user's active SSE connections so they can:
 * 1. Remove the feedId from their filter set
 * 2. Refresh the subscriptions list
 */
export interface SubscriptionDeletedEvent {
  type: "subscription_deleted";
  userId: string;
  feedId: string;
  subscriptionId: string;
  timestamp: string;
}

/**
 * Event published when an OPML import makes progress (a feed is processed).
 * Sent after each feed is processed so the UI can show real-time progress.
 */
export interface ImportProgressEvent {
  type: "import_progress";
  userId: string;
  importId: string;
  /** The URL of the feed that was just processed */
  feedUrl: string;
  /** Status of this feed: imported, skipped, or failed */
  feedStatus: "imported" | "skipped" | "failed";
  /** Current counts */
  imported: number;
  skipped: number;
  failed: number;
  total: number;
  timestamp: string;
}

/**
 * Event published when an OPML import completes (all feeds processed).
 */
export interface ImportCompletedEvent {
  type: "import_completed";
  userId: string;
  importId: string;
  /** Final counts */
  imported: number;
  skipped: number;
  failed: number;
  total: number;
  timestamp: string;
}

/**
 * Union type for all user events.
 */
export type UserEvent =
  | SubscriptionCreatedEvent
  | SubscriptionDeletedEvent
  | ImportProgressEvent
  | ImportCompletedEvent;

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
 * @returns The number of subscribers that received the message
 */
export async function publishNewEntry(
  feedId: string,
  entryId: string,
  feedType?: "web" | "email" | "saved"
): Promise<number> {
  const event: NewEntryEvent = {
    type: "new_entry",
    feedId,
    entryId,
    timestamp: new Date().toISOString(),
    feedType,
  };
  return publishFeedEvent(event);
}

/**
 * Publishes an entry_updated event when an entry content changes.
 *
 * @param feedId - The ID of the feed containing the entry
 * @param entryId - The ID of the updated entry
 * @returns The number of subscribers that received the message
 */
export async function publishEntryUpdated(feedId: string, entryId: string): Promise<number> {
  const event: EntryUpdatedEvent = {
    type: "entry_updated",
    feedId,
    entryId,
    timestamp: new Date().toISOString(),
  };
  return publishFeedEvent(event);
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
 * @param subscription - Full subscription data for optimistic cache update
 * @param feed - Full feed data for optimistic cache update
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishSubscriptionCreated(
  userId: string,
  feedId: string,
  subscriptionId: string,
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
 * @returns The number of subscribers that received the message (0 if Redis unavailable)
 */
export async function publishSubscriptionDeleted(
  userId: string,
  feedId: string,
  subscriptionId: string
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
    const parsed: unknown = JSON.parse(message);

    // Type guard to validate the event structure
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      "feedId" in parsed &&
      "entryId" in parsed &&
      "timestamp" in parsed
    ) {
      const event = parsed as {
        type: unknown;
        feedId: unknown;
        entryId: unknown;
        timestamp: unknown;
      };

      if (
        (event.type === "new_entry" || event.type === "entry_updated") &&
        typeof event.feedId === "string" &&
        typeof event.entryId === "string" &&
        typeof event.timestamp === "string"
      ) {
        return event as FeedEvent;
      }
    }

    return null;
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
    const parsed: unknown = JSON.parse(message);

    // Type guard to validate the event structure
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "type" in parsed &&
      "timestamp" in parsed
    ) {
      const event = parsed as Record<string, unknown>;

      if (
        event.type === "subscription_created" &&
        typeof event.userId === "string" &&
        typeof event.feedId === "string" &&
        typeof event.subscriptionId === "string" &&
        typeof event.timestamp === "string" &&
        typeof event.subscription === "object" &&
        event.subscription !== null &&
        typeof event.feed === "object" &&
        event.feed !== null
      ) {
        const sub = event.subscription as Record<string, unknown>;
        const feed = event.feed as Record<string, unknown>;

        // Validate subscription structure
        if (
          typeof sub.id !== "string" ||
          typeof sub.feedId !== "string" ||
          (sub.customTitle !== null && typeof sub.customTitle !== "string") ||
          typeof sub.subscribedAt !== "string" ||
          typeof sub.unreadCount !== "number" ||
          !Array.isArray(sub.tags)
        ) {
          return null;
        }

        // Validate feed structure
        if (
          typeof feed.id !== "string" ||
          (feed.type !== "web" && feed.type !== "email" && feed.type !== "saved") ||
          (feed.url !== null && typeof feed.url !== "string") ||
          (feed.title !== null && typeof feed.title !== "string") ||
          (feed.description !== null && typeof feed.description !== "string") ||
          (feed.siteUrl !== null && typeof feed.siteUrl !== "string")
        ) {
          return null;
        }

        return {
          type: "subscription_created",
          userId: event.userId,
          feedId: event.feedId,
          subscriptionId: event.subscriptionId,
          timestamp: event.timestamp,
          subscription: {
            id: sub.id,
            feedId: sub.feedId,
            customTitle: sub.customTitle as string | null,
            subscribedAt: sub.subscribedAt,
            unreadCount: sub.unreadCount,
            tags: sub.tags as Array<{ id: string; name: string; color: string | null }>,
          },
          feed: {
            id: feed.id,
            type: feed.type,
            url: feed.url as string | null,
            title: feed.title as string | null,
            description: feed.description as string | null,
            siteUrl: feed.siteUrl as string | null,
          },
        };
      }

      if (
        event.type === "subscription_deleted" &&
        typeof event.userId === "string" &&
        typeof event.feedId === "string" &&
        typeof event.subscriptionId === "string" &&
        typeof event.timestamp === "string"
      ) {
        return {
          type: "subscription_deleted",
          userId: event.userId,
          feedId: event.feedId,
          subscriptionId: event.subscriptionId,
          timestamp: event.timestamp,
        };
      }

      if (
        event.type === "import_progress" &&
        typeof event.userId === "string" &&
        typeof event.importId === "string" &&
        typeof event.feedUrl === "string" &&
        (event.feedStatus === "imported" ||
          event.feedStatus === "skipped" ||
          event.feedStatus === "failed") &&
        typeof event.imported === "number" &&
        typeof event.skipped === "number" &&
        typeof event.failed === "number" &&
        typeof event.total === "number" &&
        typeof event.timestamp === "string"
      ) {
        return {
          type: "import_progress",
          userId: event.userId,
          importId: event.importId,
          feedUrl: event.feedUrl,
          feedStatus: event.feedStatus,
          imported: event.imported,
          skipped: event.skipped,
          failed: event.failed,
          total: event.total,
          timestamp: event.timestamp,
        };
      }

      if (
        event.type === "import_completed" &&
        typeof event.userId === "string" &&
        typeof event.importId === "string" &&
        typeof event.imported === "number" &&
        typeof event.skipped === "number" &&
        typeof event.failed === "number" &&
        typeof event.total === "number" &&
        typeof event.timestamp === "string"
      ) {
        return {
          type: "import_completed",
          userId: event.userId,
          importId: event.importId,
          imported: event.imported,
          skipped: event.skipped,
          failed: event.failed,
          total: event.total,
          timestamp: event.timestamp,
        };
      }
    }

    return null;
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
