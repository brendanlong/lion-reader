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
import { getClientIp } from "@/server/http/client-ip";
import {
  type RateLimitType,
  type ConsumeResult,
  RATE_LIMIT_CONFIGS,
  getRateLimitKey,
  getRateLimitHeaders,
} from "./token-bucket";

// Re-export types and helpers
export { type RateLimitType, RATE_LIMIT_CONFIGS, getRateLimitHeaders };

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
 * Derives the rate-limit identifier for a per-account (email/username) password
 * attempt. The email is trimmed and lower-cased so that case or whitespace
 * variations can't be used to spread attempts across separate buckets.
 *
 * @param email - The email/username supplied in the login attempt
 * @returns Identifier string (namespaced so it can't collide with ip:/user: keys)
 */
export function getAccountRateLimitIdentifier(email: string): string {
  return `email:${email.trim().toLowerCase()}`;
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

  // Fall back to the client IP, derived from the trusted precedence shared with
  // session logging (Fly-Client-IP → rightmost x-forwarded-for hop → x-real-ip).
  // Keying on the spoofable leftmost x-forwarded-for entry would let a client
  // rotate a fake value to get a fresh token bucket per fake IP and bypass every
  // per-IP limit; see getClientIp.
  const clientIp = getClientIp(headers);
  if (clientIp) {
    return `ip:${clientIp}`;
  }

  // Fallback for local development (no trusted proxy header present)
  return "ip:unknown";
}

/**
 * Builds a 429 response for a rejected rate-limit result.
 */
function buildRateLimitResponse(
  result: ConsumeResult,
  type: RateLimitType,
  options: { json?: boolean }
): Response {
  const config = RATE_LIMIT_CONFIGS[type];
  const rateLimitHeaders = getRateLimitHeaders(result, config);
  const body = options.json
    ? JSON.stringify({ error: "rate_limit_exceeded", error_description: "Rate limit exceeded" })
    : "Rate limit exceeded";
  return new Response(body, {
    status: 429,
    headers: {
      ...rateLimitHeaders,
      "Content-Type": options.json ? "application/json" : "text/plain",
    },
  });
}

/**
 * Checks rate limit for a route handler request and returns a 429 Response if exceeded.
 * Returns null if the request is allowed.
 *
 * @param request - The incoming request
 * @param type - Type of rate limit to apply
 * @param options - Options for the response format
 * @returns A 429 Response if rate limited, or null if allowed
 */
export async function checkRouteRateLimit(
  request: Request,
  type: RateLimitType = "default",
  options: { json?: boolean } = {}
): Promise<Response | null> {
  const identifier = getClientIdentifier(null, request.headers);
  const result = await checkRateLimit(identifier, type);

  if (!result.allowed) {
    return buildRateLimitResponse(result, type, options);
  }

  return null;
}

/**
 * Checks the per-account rate limit for a password attempt, keyed by the
 * normalized email/username using the strict "expensive" bucket.
 *
 * This complements the per-IP `checkRouteRateLimit` (and the
 * `expensivePublicProcedure` middleware) that guard password-accepting
 * endpoints: a per-IP limit alone does not stop a distributed, IP-rotating
 * brute-force against a single account. Sharing this account key across every
 * password path (tRPC login, Google Reader ClientLogin, Wallabag password
 * grant) bounds total guesses per account regardless of source IP.
 *
 * Returns a ConsumeResult; callers turn a disallowed result into their
 * transport-appropriate error (429 Response / TRPCError).
 */
export async function checkAccountRateLimit(email: string): Promise<ConsumeResult> {
  return checkRateLimit(getAccountRateLimitIdentifier(email), "expensive");
}

/**
 * Route-handler variant of {@link checkAccountRateLimit}: returns a 429 Response
 * if the per-account limit is exceeded, or null if allowed.
 */
export async function checkAccountRouteRateLimit(
  email: string,
  options: { json?: boolean } = {}
): Promise<Response | null> {
  const result = await checkAccountRateLimit(email);
  if (!result.allowed) {
    return buildRateLimitResponse(result, "expensive", options);
  }
  return null;
}
