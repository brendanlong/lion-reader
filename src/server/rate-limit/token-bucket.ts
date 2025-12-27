/**
 * Token Bucket Rate Limiting - Pure Logic
 *
 * This module implements the token bucket algorithm as pure functions,
 * making it easy to unit test. The actual Redis storage is handled
 * separately in the rate limiter service.
 */

/**
 * Configuration for a rate limit bucket.
 */
export interface RateLimitConfig {
  /** Maximum number of tokens (burst capacity) */
  capacity: number;
  /** Tokens added per second (refill rate) */
  refillRate: number;
}

/**
 * State of a token bucket stored in Redis.
 */
export interface BucketState {
  /** Current number of tokens available */
  tokens: number;
  /** Unix timestamp (ms) when tokens were last refilled */
  lastRefillMs: number;
}

/**
 * Result of consuming a token from the bucket.
 */
export interface ConsumeResult {
  /** Whether the request was allowed */
  allowed: boolean;
  /** Number of tokens remaining after this request */
  remaining: number;
  /** Unix timestamp (ms) when bucket will be full again */
  resetMs: number;
  /** Seconds until next token is available (for Retry-After header) */
  retryAfterSeconds: number | null;
}

/**
 * Rate limit configurations for different operation types.
 */
export const RATE_LIMIT_CONFIGS = {
  /** Default rate limit for most API operations */
  default: {
    capacity: 100,
    refillRate: 10, // 10 tokens per second
  },
  /** Stricter limit for expensive operations (login, register, subscribe) */
  expensive: {
    capacity: 10,
    refillRate: 1, // 1 token per second
  },
} as const satisfies Record<string, RateLimitConfig>;

export type RateLimitType = keyof typeof RATE_LIMIT_CONFIGS;

/**
 * Calculates the number of tokens to add based on elapsed time.
 *
 * @param elapsedMs - Time elapsed since last refill in milliseconds
 * @param refillRate - Tokens per second to add
 * @returns Number of tokens to add (may be fractional)
 */
export function calculateTokensToAdd(elapsedMs: number, refillRate: number): number {
  // Convert elapsed time to seconds and multiply by rate
  return (elapsedMs / 1000) * refillRate;
}

/**
 * Refills the bucket based on elapsed time.
 * Returns the new bucket state with updated tokens and timestamp.
 *
 * @param bucket - Current bucket state
 * @param config - Rate limit configuration
 * @param nowMs - Current timestamp in milliseconds
 * @returns Updated bucket state
 */
export function refillBucket(
  bucket: BucketState,
  config: RateLimitConfig,
  nowMs: number
): BucketState {
  const elapsedMs = nowMs - bucket.lastRefillMs;

  // Don't refill if no time has passed
  if (elapsedMs <= 0) {
    return bucket;
  }

  const tokensToAdd = calculateTokensToAdd(elapsedMs, config.refillRate);
  const newTokens = Math.min(bucket.tokens + tokensToAdd, config.capacity);

  return {
    tokens: newTokens,
    lastRefillMs: nowMs,
  };
}

/**
 * Attempts to consume a token from the bucket.
 *
 * This is a pure function that calculates the result without side effects.
 * The caller is responsible for storing the updated state.
 *
 * @param bucket - Current bucket state (after refill)
 * @param config - Rate limit configuration
 * @param nowMs - Current timestamp in milliseconds
 * @param cost - Number of tokens to consume (default: 1)
 * @returns Result indicating if allowed, with updated state info
 */
export function consumeToken(
  bucket: BucketState,
  config: RateLimitConfig,
  nowMs: number,
  cost: number = 1
): { result: ConsumeResult; newState: BucketState } {
  // First refill the bucket
  const refilledBucket = refillBucket(bucket, config, nowMs);

  // Calculate time until bucket is full
  const tokensToFull = config.capacity - refilledBucket.tokens;
  const timeToFullMs = (tokensToFull / config.refillRate) * 1000;
  const resetMs = nowMs + timeToFullMs;

  // Check if we have enough tokens
  if (refilledBucket.tokens >= cost) {
    // Consume the token
    const newState: BucketState = {
      tokens: refilledBucket.tokens - cost,
      lastRefillMs: nowMs,
    };

    return {
      result: {
        allowed: true,
        remaining: Math.floor(newState.tokens),
        resetMs,
        retryAfterSeconds: null,
      },
      newState,
    };
  }

  // Not enough tokens - calculate retry after
  const tokensNeeded = cost - refilledBucket.tokens;
  const retryAfterMs = (tokensNeeded / config.refillRate) * 1000;
  const retryAfterSeconds = Math.ceil(retryAfterMs / 1000);

  return {
    result: {
      allowed: false,
      remaining: 0,
      resetMs,
      retryAfterSeconds,
    },
    newState: refilledBucket, // State unchanged when rejected
  };
}

/**
 * Creates a new bucket at full capacity.
 *
 * @param config - Rate limit configuration
 * @param nowMs - Current timestamp in milliseconds
 * @returns Initial bucket state at full capacity
 */
export function createBucket(config: RateLimitConfig, nowMs: number): BucketState {
  return {
    tokens: config.capacity,
    lastRefillMs: nowMs,
  };
}

/**
 * Generates rate limit response headers.
 *
 * @param result - The result from consuming a token
 * @param config - Rate limit configuration
 * @returns Headers to add to the response
 */
export function getRateLimitHeaders(
  result: ConsumeResult,
  config: RateLimitConfig
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": config.capacity.toString(),
    "X-RateLimit-Remaining": result.remaining.toString(),
    "X-RateLimit-Reset": Math.ceil(result.resetMs / 1000).toString(),
  };

  if (!result.allowed && result.retryAfterSeconds !== null) {
    headers["Retry-After"] = result.retryAfterSeconds.toString();
  }

  return headers;
}

/**
 * Generates the Redis key for a rate limit bucket.
 *
 * @param identifier - User ID or IP address
 * @param type - Type of rate limit (default, expensive, etc.)
 * @returns Redis key for the bucket
 */
export function getRateLimitKey(identifier: string, type: RateLimitType = "default"): string {
  return `rate_limit:${type}:${identifier}`;
}
