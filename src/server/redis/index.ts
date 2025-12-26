/**
 * Redis Client
 *
 * Provides a Redis client instance for caching and pub/sub.
 * Used for session caching, rate limiting, and real-time updates.
 */

import Redis from "ioredis";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL environment variable is not set");
}

/**
 * Redis client instance.
 * Uses ioredis for its robust connection handling and TypeScript support.
 */
export const redis = new Redis(redisUrl, {
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
  redis.on("connect", () => {
    console.log("Redis connected");
  });

  redis.on("error", (err) => {
    console.error("Redis error:", err);
  });

  redis.on("reconnecting", () => {
    console.log("Redis reconnecting...");
  });
}

export type RedisClient = typeof redis;
