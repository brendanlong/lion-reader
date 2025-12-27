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
export type FeedEventType = "new_entry" | "entry_updated";

/**
 * User event types that can be published.
 */
export type UserEventType = "subscription_created";

/**
 * Base event payload interface for feed events.
 */
interface BaseFeedEvent {
  type: FeedEventType;
  feedId: string;
  entryId: string;
  timestamp: string;
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
 * Event published when a user subscribes to a new feed.
 * This is sent to all of the user's active SSE connections so they can:
 * 1. Add the new feedId to their filter set
 * 2. Refresh the subscriptions list
 */
export interface SubscriptionCreatedEvent {
  type: "subscription_created";
  userId: string;
  feedId: string;
  subscriptionId: string;
  timestamp: string;
}

/**
 * Union type for all user events.
 */
export type UserEvent = SubscriptionCreatedEvent;

/**
 * Channel name for feed events.
 * Using a single channel for all feed events simplifies subscription management.
 * Events include feedId so subscribers can filter as needed.
 */
export const FEED_EVENTS_CHANNEL = "feed:events";

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

/**
 * Gets or creates the Redis publisher client.
 * Uses lazy initialization to avoid connection issues during module load.
 *
 * @returns Redis client configured for publishing
 */
function getPublisherClient(): Redis {
  if (publisherClient) {
    return publisherClient;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL environment variable is not set");
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
 * Publishes a feed event to Redis.
 *
 * @param event - The event to publish
 * @returns The number of subscribers that received the message
 */
export async function publishFeedEvent(event: FeedEvent): Promise<number> {
  const client = getPublisherClient();
  const message = JSON.stringify(event);
  return client.publish(FEED_EVENTS_CHANNEL, message);
}

/**
 * Publishes a new_entry event when an entry is created.
 *
 * @param feedId - The ID of the feed containing the entry
 * @param entryId - The ID of the newly created entry
 * @returns The number of subscribers that received the message
 */
export async function publishNewEntry(feedId: string, entryId: string): Promise<number> {
  const event: NewEntryEvent = {
    type: "new_entry",
    feedId,
    entryId,
    timestamp: new Date().toISOString(),
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
 * 2. Refresh the subscriptions list in the UI
 *
 * @param userId - The ID of the user who subscribed
 * @param feedId - The ID of the feed they subscribed to
 * @param subscriptionId - The ID of the new subscription
 * @returns The number of subscribers that received the message
 */
export async function publishSubscriptionCreated(
  userId: string,
  feedId: string,
  subscriptionId: string
): Promise<number> {
  const client = getPublisherClient();
  const event: SubscriptionCreatedEvent = {
    type: "subscription_created",
    userId,
    feedId,
    subscriptionId,
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
 * @returns A new Redis client configured for subscribing
 */
export function createSubscriberClient(): Redis {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL environment variable is not set");
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
        typeof event.timestamp === "string"
      ) {
        return {
          type: "subscription_created",
          userId: event.userId,
          feedId: event.feedId,
          subscriptionId: event.subscriptionId,
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
 * Closes the publisher client connection.
 * Should be called during graceful shutdown.
 */
export async function closePublisher(): Promise<void> {
  if (publisherClient) {
    await publisherClient.quit();
    publisherClient = null;
  }
}
