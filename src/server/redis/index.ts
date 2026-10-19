/**
 * Redis Client
 *
 * Provides a Redis client instance for caching and pub/sub.
 * Used for rate limiting and real-time updates.
 *
 * Redis is optional - the app can run without it, falling back to:
 * - Permissive rate limiting (no rate limits applied)
 * - Pull-based sync instead of real-time SSE updates
 */

import Redis from "ioredis";

/**
 * Lazily-initialized Redis client instance.
 * Will be null if REDIS_URL is not set.
 */
let redisClient: Redis | null = null;

/**
 * Upper bound on how long a command may take, including time spent queued while
 * the connection is down. Request-path callers fall back when Redis fails, but
 * ioredis's default retries hold a command for minutes when the host is
 * unreachable, which hangs every request that touches Redis. A timed-out
 * command can still run once the connection recovers.
 */
export const REDIS_COMMAND_TIMEOUT_MS = 1000;

/**
 * Drop the connection when a reply is this overdue, so a host that vanished
 * without closing the socket gets reconnected instead of timing out every
 * command until the OS gives up on it (~15 minutes).
 */
export const REDIS_SOCKET_TIMEOUT_MS = 3000;
let redisInitialized = false;

/**
 * Gets the Redis client, initializing it lazily if needed.
 * Returns null if REDIS_URL is not set.
 */
export function getRedisClient(): Redis | null {
  if (redisInitialized) {
    return redisClient;
  }

  redisInitialized = true;

  // During `next build`, route modules are imported and the root layout's
  // getAnnouncement() runs while prerendering static pages. REDIS_URL is set to a
  // dummy value (see Dockerfile) that nothing listens on, so eagerly creating a
  // client here (lazyConnect: false) makes ioredis spew hundreds of
  // "[ioredis] Unhandled error event: AggregateError" lines as the connection
  // retries against a dead address — thousands of lines of build-log noise.
  // Skip Redis during the build phase: every consumer already treats a null
  // client as "Redis unavailable" and falls back safely (e.g. getSiteStatus
  // returns no announcement). At runtime NEXT_PHASE is unset, so this is a no-op.
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return null;
  }

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
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    socketTimeout: REDIS_SOCKET_TIMEOUT_MS,
    // Flush queued commands with an error on each failed reconnect instead of
    // holding them through 20 attempts.
    maxRetriesPerRequest: 1,
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

/** Closes the client if one was ever created. */
export async function closeRedisClient(): Promise<void> {
  if (!redisClient) return;
  // QUIT times out if Redis is unreachable; that must not fail the shutdown.
  try {
    await redisClient.quit();
  } catch {
    redisClient.disconnect();
  }
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
