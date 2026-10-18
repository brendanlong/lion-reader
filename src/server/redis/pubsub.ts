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

import { logger } from "@/lib/logger";
import Redis from "ioredis";
import { z } from "zod";
import { getRedisClient } from "@/server/redis";
import {
  entryMetadataSchema,
  newEntryListDataSchema,
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
  importProgressEventBaseSchema,
  importCompletedEventBaseSchema,
  announcementChangedEventBaseSchema,
} from "@/lib/events/schemas";

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

// Server-side events always carry a timestamp; the client schemas default it.
const serverTimestamp = { timestamp: z.string() };

/**
 * Zod schema for user events published/received via Redis pub/sub: each
 * client event (`@/lib/events/schemas`) plus the recipient's `userId` and
 * whatever the SSE route consumes before forwarding.
 */
const userEventSchema = z.discriminatedUnion("type", [
  // Entry events for sources with exactly one recipient (email, saved), which
  // go to that user's channel instead of a feed channel. They carry what the
  // SSE route adds to a web feed's events itself: the user's subscriptionId
  // (null for saved articles).
  newEntryEventSchema.extend({
    userId: z.string(),
    ...serverTimestamp,
    feedType: z.enum(["email", "saved"]),
  }),
  entryUpdatedEventSchema.extend({
    userId: z.string(),
    ...serverTimestamp,
    // Unread, but the previous release's SSE servers require it: drop it the
    // release after this one.
    feedType: z.enum(["email", "saved"]).optional(),
  }),
  subscriptionCreatedEventSchema.extend({
    userId: z.string(),
    ...serverTimestamp,
    // The feed channel to follow; null for a subscription without a feed (#1846).
    feedId: z.string().nullable(),
  }),
  subscriptionUpdatedEventSchema.extend({ userId: z.string(), ...serverTimestamp }),
  subscriptionDeletedEventSchema.extend({
    userId: z.string(),
    ...serverTimestamp,
    feedId: z.string().nullable(),
  }),
  importProgressEventBaseSchema.extend({ userId: z.string(), ...serverTimestamp }),
  importCompletedEventBaseSchema.extend({ userId: z.string(), ...serverTimestamp }),
  entryStateChangedEventSchema.extend({ userId: z.string(), ...serverTimestamp }),
  markAllReadEventSchema.extend({ userId: z.string(), ...serverTimestamp }),
  tagCreatedEventSchema.extend({ userId: z.string(), ...serverTimestamp }),
  tagUpdatedEventSchema.extend({ userId: z.string(), ...serverTimestamp }),
  tagDeletedEventSchema.extend({ userId: z.string(), ...serverTimestamp }),
  collectionEntriesChangedEventSchema.extend({ userId: z.string(), ...serverTimestamp }),
]);

/**
 * Zod schema for the global site-status channel: a single broadcast channel
 * (not per-user) so an admin change reaches every connected client.
 */
const siteStatusEventSchema = announcementChangedEventBaseSchema.extend(serverTimestamp);

/** Union type for all site-status events. */
export type SiteStatusEvent = z.infer<typeof siteStatusEventSchema>;

// ============================================================================
// Derived Types (all derived from Zod schemas above)
// ============================================================================

/** Union type for all feed events. */
export type FeedEvent = z.infer<typeof feedEventSchema>;
/** Union type for all user events. */
export type UserEvent = z.infer<typeof userEventSchema>;

export type EntryUpdatedMetadata = z.infer<typeof entryMetadataSchema>;

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
 * An event as its publisher supplies it: without the `timestamp`, which the
 * publish stamps, and with a required `updatedAt` as the row's `Date`.
 */
type Published<E> = E extends { updatedAt: string }
  ? Omit<E, "timestamp" | "updatedAt"> & { updatedAt: Date }
  : Omit<E, "timestamp" | "updatedAt">;

function stamp<E>(event: Published<E>): E {
  const { updatedAt, ...rest } = event as { updatedAt?: Date };
  return {
    ...rest,
    timestamp: new Date().toISOString(),
    ...(updatedAt && { updatedAt: updatedAt.toISOString() }),
  } as E;
}

/**
 * Publishes an event to a Redis channel. Every publisher below funnels
 * through here: this owns the client lookup, serialization, and the failure
 * handling.
 *
 * Events are best-effort (clients catch up through sync), so this never
 * throws: a failed publish is logged here, and callers neither catch nor
 * await it unless they need the subscriber count.
 *
 * @returns The number of subscribers that received the message (0 if Redis is
 *   unavailable or the publish failed)
 */
async function publishToChannel(
  channel: string,
  event: FeedEvent | UserEvent | SiteStatusEvent
): Promise<number> {
  // Published on the shared main client: PUBLISH is an ordinary command, so it
  // needs no dedicated connection (only SUBSCRIBE mode does — see
  // getSharedSubscriberClient).
  try {
    const client = getRedisClient();
    if (!client) {
      return 0;
    }
    return await client.publish(channel, JSON.stringify(event));
  } catch (err) {
    logger.error("Failed to publish event", { err, channel, type: event.type });
    return 0;
  }
}

// Each event scope derives its own channel from the event, so a user event can't
// be published to a feed's channel (which every subscriber of that feed reads)
// by passing the wrong channel name. See SECURITY.md on cross-user isolation.

/**
 * Publishes a web feed's entry event to the feed's channel. Email and saved
 * entries have one recipient, so theirs go through publishUserEvent.
 */
export async function publishFeedEvent(event: Published<FeedEvent>): Promise<number> {
  return publishToChannel(getFeedEventsChannel(event.feedId), stamp<FeedEvent>(event));
}

/** Publishes a user event to that user's channel. */
export async function publishUserEvent(event: Published<UserEvent>): Promise<number> {
  return publishToChannel(getUserEventsChannel(event.userId), stamp<UserEvent>(event));
}

/** Publishes an event to the single global site-status channel. */
export async function publishSiteStatusEvent(event: Published<SiteStatusEvent>): Promise<number> {
  return publishToChannel(getSiteStatusChannel(), stamp<SiteStatusEvent>(event));
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
