/**
 * Redis Client
 *
 * Provides a Redis client instance for caching and pub/sub.
 * Used for session caching, rate limiting, and real-time updates.
 *
 * Redis is optional - the app can run without it, falling back to:
 * - Database-only session lookups (slower but functional)
 * - Permissive rate limiting (no rate limits applied)
 * - Pull-based sync instead of real-time SSE updates
 */

import Redis from "ioredis";

/**
 * Lazily-initialized Redis client instance.
 * Will be null if REDIS_URL is not set.
 */
let redisClient: Redis | null = null;
let redisInitialized = false;

/**
 * Checks if Redis is configured (REDIS_URL is set).
 */
export function isRedisConfigured(): boolean {
  return !!process.env.REDIS_URL;
}

/**
 * Gets the Redis client, initializing it lazily if needed.
 * Returns null if REDIS_URL is not set.
 */
export function getRedisClient(): Redis | null {
  if (redisInitialized) {
    return redisClient;
  }

  redisInitialized = true;
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    if (process.env.NODE_ENV === "development") {
      console.log("Redis not configured (REDIS_URL not set) - using fallback modes");
    }
    return null;
  }

  redisClient = new Redis(redisUrl, {
    // Enable auto-pipelining for better performance with many small commands
    enableAutoPipelining: true,
    // Reconnect with exponential backoff
    retryStrategy(times) {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    // Don't throw on connection errors during startup
    lazyConnect: false,
  });

  // Log connection events in development
  if (process.env.NODE_ENV === "development") {
    redisClient.on("connect", () => {
      console.log("Redis connected");
    });

    redisClient.on("error", (err) => {
      console.error("Redis error:", err);
    });

    redisClient.on("reconnecting", () => {
      console.log("Redis reconnecting...");
    });
  }

  return redisClient;
}

/**
 * Legacy export for backwards compatibility.
 * @deprecated Use getRedisClient() instead to handle null case.
 * This getter will throw if Redis is not configured.
 */
export const redis = new Proxy({} as Redis, {
  get(_, prop) {
    const client = getRedisClient();
    if (!client) {
      throw new Error("Redis is not configured (REDIS_URL not set)");
    }
    const value = client[prop as keyof Redis];
    if (typeof value === "function") {
      return value.bind(client);
    }
    return value;
  },
});

export type RedisClient = Redis;

// Re-export pub/sub functionality
export {
  publishFeedEvent,
  publishNewEntry,
  publishEntryUpdated,
  publishSubscriptionCreated,
  createSubscriberClient,
  parseFeedEvent,
  parseUserEvent,
  closePublisher,
  checkRedisHealth,
  getFeedEventsChannel,
  getUserEventsChannel,
  type FeedEvent,
  type FeedEventType,
  type NewEntryEvent,
  type EntryUpdatedEvent,
  type UserEvent,
  type UserEventType,
  type SubscriptionCreatedEvent,
} from "./pubsub";
