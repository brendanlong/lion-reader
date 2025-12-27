/**
 * Unit tests for token bucket rate limiting pure logic.
 */

import { describe, it, expect } from "vitest";
import {
  calculateTokensToAdd,
  refillBucket,
  consumeToken,
  createBucket,
  getRateLimitHeaders,
  getRateLimitKey,
  RATE_LIMIT_CONFIGS,
  type BucketState,
  type RateLimitConfig,
  type ConsumeResult,
} from "../../src/server/rate-limit/token-bucket";

/**
 * Helper to create a bucket state with defaults.
 */
function createBucketState(overrides: Partial<BucketState> = {}): BucketState {
  return {
    tokens: 100,
    lastRefillMs: Date.now(),
    ...overrides,
  };
}

describe("RATE_LIMIT_CONFIGS", () => {
  it("has default config with 100 capacity and 10/sec refill", () => {
    expect(RATE_LIMIT_CONFIGS.default).toEqual({
      capacity: 100,
      refillRate: 10,
    });
  });

  it("has expensive config with 10 capacity and 1/sec refill", () => {
    expect(RATE_LIMIT_CONFIGS.expensive).toEqual({
      capacity: 10,
      refillRate: 1,
    });
  });
});

describe("calculateTokensToAdd", () => {
  it("calculates correct tokens for 1 second", () => {
    expect(calculateTokensToAdd(1000, 10)).toBe(10);
  });

  it("calculates correct tokens for half second", () => {
    expect(calculateTokensToAdd(500, 10)).toBe(5);
  });

  it("calculates correct tokens for 5 seconds", () => {
    expect(calculateTokensToAdd(5000, 10)).toBe(50);
  });

  it("returns 0 for 0 elapsed time", () => {
    expect(calculateTokensToAdd(0, 10)).toBe(0);
  });

  it("works with different refill rates", () => {
    expect(calculateTokensToAdd(1000, 1)).toBe(1);
    expect(calculateTokensToAdd(1000, 100)).toBe(100);
  });

  it("handles fractional tokens", () => {
    expect(calculateTokensToAdd(100, 10)).toBe(1);
    expect(calculateTokensToAdd(50, 10)).toBe(0.5);
  });
});

describe("refillBucket", () => {
  const config: RateLimitConfig = { capacity: 100, refillRate: 10 };

  it("does not refill when no time has passed", () => {
    const nowMs = 1000000;
    const bucket = createBucketState({ tokens: 50, lastRefillMs: nowMs });

    const result = refillBucket(bucket, config, nowMs);

    expect(result.tokens).toBe(50);
    expect(result.lastRefillMs).toBe(nowMs);
  });

  it("refills tokens based on elapsed time", () => {
    const startMs = 1000000;
    const nowMs = startMs + 1000; // 1 second later
    const bucket = createBucketState({ tokens: 50, lastRefillMs: startMs });

    const result = refillBucket(bucket, config, nowMs);

    expect(result.tokens).toBe(60); // 50 + 10
    expect(result.lastRefillMs).toBe(nowMs);
  });

  it("caps tokens at capacity", () => {
    const startMs = 1000000;
    const nowMs = startMs + 10000; // 10 seconds later
    const bucket = createBucketState({ tokens: 50, lastRefillMs: startMs });

    const result = refillBucket(bucket, config, nowMs);

    expect(result.tokens).toBe(100); // Capped at capacity
  });

  it("does not refill when time goes backwards", () => {
    const startMs = 1000000;
    const nowMs = startMs - 1000; // 1 second in the past
    const bucket = createBucketState({ tokens: 50, lastRefillMs: startMs });

    const result = refillBucket(bucket, config, nowMs);

    expect(result.tokens).toBe(50);
    expect(result.lastRefillMs).toBe(startMs);
  });

  it("handles full bucket correctly", () => {
    const startMs = 1000000;
    const nowMs = startMs + 1000;
    const bucket = createBucketState({ tokens: 100, lastRefillMs: startMs });

    const result = refillBucket(bucket, config, nowMs);

    expect(result.tokens).toBe(100); // Already at capacity
    expect(result.lastRefillMs).toBe(nowMs);
  });
});

describe("consumeToken", () => {
  const config: RateLimitConfig = { capacity: 100, refillRate: 10 };
  const nowMs = 1000000;

  it("allows request when tokens available", () => {
    const bucket = createBucketState({ tokens: 100, lastRefillMs: nowMs });

    const { result, newState } = consumeToken(bucket, config, nowMs);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(99);
    expect(result.retryAfterSeconds).toBeNull();
    expect(newState.tokens).toBe(99);
  });

  it("rejects request when no tokens available", () => {
    const bucket = createBucketState({ tokens: 0, lastRefillMs: nowMs });

    const { result, newState } = consumeToken(bucket, config, nowMs);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBe(1); // Need 1 token, 10/sec = 0.1s, ceil = 1
    expect(newState.tokens).toBe(0); // State unchanged
  });

  it("calculates retry-after correctly", () => {
    const bucket = createBucketState({ tokens: 0.5, lastRefillMs: nowMs });

    const { result } = consumeToken(bucket, config, nowMs);

    expect(result.allowed).toBe(false);
    // Need 0.5 tokens, 10/sec = 0.05s, ceil = 1
    expect(result.retryAfterSeconds).toBe(1);
  });

  it("consumes multiple tokens when cost > 1", () => {
    const bucket = createBucketState({ tokens: 10, lastRefillMs: nowMs });

    const { result, newState } = consumeToken(bucket, config, nowMs, 5);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
    expect(newState.tokens).toBe(5);
  });

  it("rejects when cost exceeds available tokens", () => {
    const bucket = createBucketState({ tokens: 3, lastRefillMs: nowMs });

    const { result } = consumeToken(bucket, config, nowMs, 5);

    expect(result.allowed).toBe(false);
    // Need 2 more tokens, 10/sec = 0.2s, ceil = 1
    expect(result.retryAfterSeconds).toBe(1);
  });

  it("refills before consuming", () => {
    const startMs = 1000000;
    const laterMs = startMs + 1000; // 1 second later
    const bucket = createBucketState({ tokens: 0, lastRefillMs: startMs });

    const { result, newState } = consumeToken(bucket, config, laterMs);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9); // 10 refilled - 1 consumed
    expect(newState.tokens).toBe(9);
  });

  it("calculates reset time correctly for empty bucket", () => {
    const bucket = createBucketState({ tokens: 0, lastRefillMs: nowMs });

    const { result } = consumeToken(bucket, config, nowMs);

    // Time to full = 100 tokens / 10 per sec = 10 seconds = 10000ms
    expect(result.resetMs).toBe(nowMs + 10000);
  });

  it("calculates reset time correctly for partial bucket", () => {
    const bucket = createBucketState({ tokens: 50, lastRefillMs: nowMs });

    const { result } = consumeToken(bucket, config, nowMs);

    // Reset time is calculated before consuming
    // Time to full from 50 tokens = (100 - 50) / 10 = 5 seconds = 5000ms
    expect(result.resetMs).toBe(nowMs + 5000);
  });
});

describe("createBucket", () => {
  const config: RateLimitConfig = { capacity: 100, refillRate: 10 };
  const nowMs = 1000000;

  it("creates bucket at full capacity", () => {
    const bucket = createBucket(config, nowMs);

    expect(bucket.tokens).toBe(100);
    expect(bucket.lastRefillMs).toBe(nowMs);
  });

  it("uses config capacity for different configs", () => {
    const smallConfig: RateLimitConfig = { capacity: 10, refillRate: 1 };
    const bucket = createBucket(smallConfig, nowMs);

    expect(bucket.tokens).toBe(10);
  });
});

describe("getRateLimitHeaders", () => {
  const config: RateLimitConfig = { capacity: 100, refillRate: 10 };

  it("returns correct headers for allowed request", () => {
    const result: ConsumeResult = {
      allowed: true,
      remaining: 99,
      resetMs: 1000000,
      retryAfterSeconds: null,
    };

    const headers = getRateLimitHeaders(result, config);

    expect(headers).toEqual({
      "X-RateLimit-Limit": "100",
      "X-RateLimit-Remaining": "99",
      "X-RateLimit-Reset": "1000",
    });
  });

  it("returns Retry-After header for rejected request", () => {
    const result: ConsumeResult = {
      allowed: false,
      remaining: 0,
      resetMs: 1010000,
      retryAfterSeconds: 5,
    };

    const headers = getRateLimitHeaders(result, config);

    expect(headers).toEqual({
      "X-RateLimit-Limit": "100",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "1010",
      "Retry-After": "5",
    });
  });

  it("rounds reset time to seconds", () => {
    const result: ConsumeResult = {
      allowed: true,
      remaining: 50,
      resetMs: 1000500, // 1000.5 seconds in Unix time
      retryAfterSeconds: null,
    };

    const headers = getRateLimitHeaders(result, config);

    expect(headers["X-RateLimit-Reset"]).toBe("1001"); // Rounded up
  });
});

describe("getRateLimitKey", () => {
  it("generates default key for user", () => {
    expect(getRateLimitKey("user:abc123")).toBe("rate_limit:default:user:abc123");
  });

  it("generates expensive key for user", () => {
    expect(getRateLimitKey("user:abc123", "expensive")).toBe("rate_limit:expensive:user:abc123");
  });

  it("generates key for IP address", () => {
    expect(getRateLimitKey("ip:192.168.1.1")).toBe("rate_limit:default:ip:192.168.1.1");
  });

  it("handles default type parameter", () => {
    expect(getRateLimitKey("test")).toBe("rate_limit:default:test");
  });
});

describe("integration scenarios", () => {
  const config: RateLimitConfig = { capacity: 10, refillRate: 1 };

  it("allows burst of requests up to capacity", () => {
    let bucket = createBucket(config, 1000000);

    // Make 10 requests in quick succession
    for (let i = 0; i < 10; i++) {
      const { result, newState } = consumeToken(bucket, config, 1000000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(10 - i - 1);
      bucket = newState;
    }

    // 11th request should be rejected
    const { result } = consumeToken(bucket, config, 1000000);
    expect(result.allowed).toBe(false);
  });

  it("allows more requests after waiting", () => {
    let nowMs = 1000000;
    let bucket = createBucket(config, nowMs);

    // Exhaust all tokens
    for (let i = 0; i < 10; i++) {
      const { newState } = consumeToken(bucket, config, nowMs);
      bucket = newState;
    }

    // Wait 2 seconds
    nowMs += 2000;

    // Should be able to make 2 more requests
    for (let i = 0; i < 2; i++) {
      const { result, newState } = consumeToken(bucket, config, nowMs);
      expect(result.allowed).toBe(true);
      bucket = newState;
    }

    // 3rd request should be rejected
    const { result } = consumeToken(bucket, config, nowMs);
    expect(result.allowed).toBe(false);
  });

  it("recovers fully after waiting long enough", () => {
    const startMs = 1000000;
    let bucket = createBucket(config, startMs);

    // Exhaust all tokens
    for (let i = 0; i < 10; i++) {
      const { newState } = consumeToken(bucket, config, startMs);
      bucket = newState;
    }

    // Wait 15 seconds (more than enough to refill to capacity)
    const laterMs = startMs + 15000;

    // Should have full capacity again
    const { result, newState } = consumeToken(bucket, config, laterMs);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9); // 10 refilled (capped) - 1 consumed

    // Verify we can make 9 more requests
    bucket = newState;
    for (let i = 0; i < 9; i++) {
      const { result: r, newState: ns } = consumeToken(bucket, config, laterMs);
      expect(r.allowed).toBe(true);
      bucket = ns;
    }

    // 10th additional request should be rejected
    const { result: final } = consumeToken(bucket, config, laterMs);
    expect(final.allowed).toBe(false);
  });

  it("works with expensive operation limits", () => {
    const expensiveConfig = RATE_LIMIT_CONFIGS.expensive;
    let nowMs = 1000000;
    let bucket = createBucket(expensiveConfig, nowMs);

    // Can make 10 requests
    for (let i = 0; i < 10; i++) {
      const { result, newState } = consumeToken(bucket, expensiveConfig, nowMs);
      expect(result.allowed).toBe(true);
      bucket = newState;
    }

    // 11th should fail
    const { result } = consumeToken(bucket, expensiveConfig, nowMs);
    expect(result.allowed).toBe(false);

    // Wait 1 second
    nowMs += 1000;

    // Can make 1 more request
    const { result: after } = consumeToken(bucket, expensiveConfig, nowMs);
    expect(after.allowed).toBe(true);
  });
});
