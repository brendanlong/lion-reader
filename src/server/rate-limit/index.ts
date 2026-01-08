/**
 * Redis Rate Limiter Service
 *
 * Implements token bucket rate limiting using Redis for distributed storage.
 * Uses a Lua script for atomic token consumption.
 *
 * When Redis is unavailable, falls back to permissive mode (allow all requests).
 * This is a trade-off: we prefer availability over strict rate limiting when
 * the rate limiting infrastructure is down.
 */

import { getRedisClient } from "@/server/redis";
import {
  type RateLimitConfig,
  type RateLimitType,
  type ConsumeResult,
  RATE_LIMIT_CONFIGS,
  getRateLimitKey,
  getRateLimitHeaders,
} from "./token-bucket";

// Re-export types and helpers
export {
  type RateLimitConfig,
  type RateLimitType,
  type ConsumeResult,
  RATE_LIMIT_CONFIGS,
  getRateLimitHeaders,
};

/**
 * Lua script for atomic token bucket rate limiting.
 *
 * This script:
 * 1. Gets or initializes the bucket state
 * 2. Refills tokens based on elapsed time
 * 3. Attempts to consume the requested tokens
 * 4. Returns the result (allowed, remaining, reset time, retry after)
 *
 * Keys: [bucket_key]
 * Args: [capacity, refill_rate, now_ms, cost]
 * Returns: [allowed (0/1), remaining, reset_ms, retry_after_seconds]
 */
const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

-- Get current state or initialize
local data = redis.call('HMGET', key, 'tokens', 'last_refill_ms')
local tokens = tonumber(data[1])
local last_refill_ms = tonumber(data[2])

-- Initialize if bucket doesn't exist
if not tokens then
  tokens = capacity
  last_refill_ms = now_ms
end

-- Calculate tokens to add based on elapsed time
local elapsed_ms = now_ms - last_refill_ms
if elapsed_ms > 0 then
  local tokens_to_add = (elapsed_ms / 1000) * refill_rate
  tokens = math.min(tokens + tokens_to_add, capacity)
  last_refill_ms = now_ms
end

-- Calculate reset time (when bucket will be full)
local tokens_to_full = capacity - tokens
local time_to_full_ms = (tokens_to_full / refill_rate) * 1000
local reset_ms = now_ms + time_to_full_ms

-- Check if we can consume tokens
local allowed = 0
local remaining = 0
local retry_after_seconds = 0

if tokens >= cost then
  -- Consume tokens
  tokens = tokens - cost
  allowed = 1
  remaining = math.floor(tokens)
  retry_after_seconds = 0

  -- Update bucket state
  redis.call('HSET', key, 'tokens', tokens, 'last_refill_ms', last_refill_ms)

  -- Set expiry to prevent stale keys (bucket full time + buffer)
  local ttl_seconds = math.ceil(capacity / refill_rate) + 60
  redis.call('EXPIRE', key, ttl_seconds)
else
  -- Rate limited - calculate retry after
  local tokens_needed = cost - tokens
  retry_after_seconds = math.ceil((tokens_needed / refill_rate))

  -- Still update the refill timestamp
  redis.call('HSET', key, 'tokens', tokens, 'last_refill_ms', last_refill_ms)

  -- Set expiry
  local ttl_seconds = math.ceil(capacity / refill_rate) + 60
  redis.call('EXPIRE', key, ttl_seconds)
end

return {allowed, remaining, reset_ms, retry_after_seconds}
`;

/**
 * Checks rate limit for an identifier using token bucket algorithm.
 *
 * @param identifier - User ID or IP address
 * @param type - Type of rate limit to apply
 * @param cost - Number of tokens to consume (default: 1)
 * @returns ConsumeResult with allowed status and rate limit info
 */
export async function checkRateLimit(
  identifier: string,
  type: RateLimitType = "default",
  cost: number = 1
): Promise<ConsumeResult> {
  const redis = getRedisClient();
  const config = RATE_LIMIT_CONFIGS[type];

  // If Redis is not available, fall back to permissive mode
  if (!redis) {
    return {
      allowed: true,
      remaining: config.capacity,
      resetMs: Date.now() + 60000, // Reset in 1 minute (arbitrary)
      retryAfterSeconds: null,
    };
  }

  const key = getRateLimitKey(identifier, type);
  const nowMs = Date.now();

  try {
    const result = (await redis.eval(
      TOKEN_BUCKET_SCRIPT,
      1,
      key,
      config.capacity,
      config.refillRate,
      nowMs,
      cost
    )) as [number, number, number, number];

    const [allowed, remaining, resetMs, retryAfterSeconds] = result;

    return {
      allowed: allowed === 1,
      remaining,
      resetMs,
      retryAfterSeconds: allowed === 0 ? retryAfterSeconds : null,
    };
  } catch (err) {
    // Redis error - fall back to permissive mode
    console.error("Rate limit check failed:", err);
    return {
      allowed: true,
      remaining: config.capacity,
      resetMs: Date.now() + 60000,
      retryAfterSeconds: null,
    };
  }
}

/**
 * Gets the current rate limit status without consuming tokens.
 *
 * @param identifier - User ID or IP address
 * @param type - Type of rate limit to check
 * @returns Current bucket status or null if bucket doesn't exist or Redis unavailable
 */
export async function getRateLimitStatus(
  identifier: string,
  type: RateLimitType = "default"
): Promise<{ tokens: number; remaining: number } | null> {
  const redis = getRedisClient();

  // If Redis is not available, return null (no status available)
  if (!redis) {
    return null;
  }

  const key = getRateLimitKey(identifier, type);
  const config = RATE_LIMIT_CONFIGS[type];
  const nowMs = Date.now();

  try {
    const data = await redis.hmget(key, "tokens", "last_refill_ms");

    if (!data[0] || !data[1]) {
      return null;
    }

    const tokens = parseFloat(data[0]);
    const lastRefillMs = parseInt(data[1], 10);

    // Calculate refilled tokens
    const elapsedMs = nowMs - lastRefillMs;
    const tokensToAdd = (elapsedMs / 1000) * config.refillRate;
    const currentTokens = Math.min(tokens + tokensToAdd, config.capacity);

    return {
      tokens: currentTokens,
      remaining: Math.floor(currentTokens),
    };
  } catch (err) {
    console.error("Failed to get rate limit status:", err);
    return null;
  }
}

/**
 * Resets the rate limit for an identifier (useful for testing).
 *
 * @param identifier - User ID or IP address
 * @param type - Type of rate limit to reset
 */
export async function resetRateLimit(
  identifier: string,
  type: RateLimitType = "default"
): Promise<void> {
  const redis = getRedisClient();

  // If Redis is not available, nothing to reset
  if (!redis) {
    return;
  }

  const key = getRateLimitKey(identifier, type);
  try {
    await redis.del(key);
  } catch (err) {
    console.error("Failed to reset rate limit:", err);
  }
}

/**
 * Extracts a client identifier from request headers.
 * Uses user ID if authenticated, otherwise falls back to IP address.
 *
 * @param userId - Authenticated user ID (if available)
 * @param headers - Request headers
 * @returns Identifier string for rate limiting
 */
export function getClientIdentifier(userId: string | null, headers: Headers): string {
  // Use user ID if authenticated
  if (userId) {
    return `user:${userId}`;
  }

  // Fall back to IP address
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    // Get the first IP in the chain (client IP)
    return `ip:${forwardedFor.split(",")[0].trim()}`;
  }

  const realIp = headers.get("x-real-ip");
  if (realIp) {
    return `ip:${realIp}`;
  }

  // Fallback for local development
  return "ip:unknown";
}
