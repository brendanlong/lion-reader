/**
 * Unit tests for next fetch time scheduling.
 */

import { describe, it, expect } from "vitest";
import {
  calculateNextFetch,
  calculateFailureBackoff,
  calculateJitter,
  syndicationToSeconds,
  MIN_FETCH_INTERVAL_SECONDS,
  shouldRefetchOnSubscribe,
  MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS,
  MAX_FETCH_INTERVAL_SECONDS,
  RATE_LIMIT_MAX_BACKOFF_SECONDS,
  DEFAULT_FETCH_INTERVAL_SECONDS,
  DEFAULT_JITTER_FRACTION,
  FAILURE_BASE_BACKOFF_SECONDS,
  MAX_CONSECUTIVE_FAILURES,
  MAX_JITTER_SECONDS,
  WEBSUB_BACKUP_POLL_INTERVAL_SECONDS,
} from "../../src/server/feed/scheduling";
import type { CacheControl } from "../../src/server/feed/cache-headers";

/**
 * Helper to create a CacheControl object with defaults.
 */
function createCacheControl(overrides: Partial<CacheControl> = {}): CacheControl {
  return {
    noStore: false,
    ...overrides,
  };
}

/**
 * Returns a random source that always returns 0 (no jitter).
 * Use this for deterministic tests that check exact interval values.
 */
const noJitter = () => 0;

/** `seconds` after `date`. */
function after(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

describe("syndicationToSeconds", () => {
  it("returns undefined for undefined hints", () => {
    expect(syndicationToSeconds(undefined)).toBeUndefined();
  });

  it("returns undefined when updatePeriod is missing", () => {
    expect(syndicationToSeconds({ updateFrequency: 2 })).toBeUndefined();
  });

  it("calculates hourly period correctly", () => {
    expect(syndicationToSeconds({ updatePeriod: "hourly" })).toBe(60 * 60);
    expect(syndicationToSeconds({ updatePeriod: "hourly", updateFrequency: 2 })).toBe(30 * 60);
    expect(syndicationToSeconds({ updatePeriod: "hourly", updateFrequency: 4 })).toBe(15 * 60);
  });

  it("calculates daily period correctly", () => {
    expect(syndicationToSeconds({ updatePeriod: "daily" })).toBe(24 * 60 * 60);
    expect(syndicationToSeconds({ updatePeriod: "daily", updateFrequency: 2 })).toBe(12 * 60 * 60);
    expect(syndicationToSeconds({ updatePeriod: "daily", updateFrequency: 4 })).toBe(6 * 60 * 60);
  });

  it("calculates weekly period correctly", () => {
    expect(syndicationToSeconds({ updatePeriod: "weekly" })).toBe(7 * 24 * 60 * 60);
    expect(syndicationToSeconds({ updatePeriod: "weekly", updateFrequency: 7 })).toBe(24 * 60 * 60);
  });

  it("calculates monthly period correctly", () => {
    expect(syndicationToSeconds({ updatePeriod: "monthly" })).toBe(30 * 24 * 60 * 60);
    expect(syndicationToSeconds({ updatePeriod: "monthly", updateFrequency: 2 })).toBe(
      15 * 24 * 60 * 60
    );
  });

  it("calculates yearly period correctly", () => {
    expect(syndicationToSeconds({ updatePeriod: "yearly" })).toBe(365 * 24 * 60 * 60);
  });

  it("returns undefined for zero or negative frequency", () => {
    expect(syndicationToSeconds({ updatePeriod: "daily", updateFrequency: 0 })).toBeUndefined();
    expect(syndicationToSeconds({ updatePeriod: "daily", updateFrequency: -1 })).toBeUndefined();
  });
});

describe("calculateNextFetch", () => {
  const fixedNow = new Date("2024-01-15T12:00:00Z");

  describe("with cache headers", () => {
    it("respects Cache-Control max-age above minimum", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 7200 }), // 2 hours (above 60 min default)
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T14:00:00Z"));
      expect(result.intervalSeconds).toBe(7200);
      expect(result.reason).toBe("cache_control");
    });

    it("respects s-maxage over max-age", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 3600, sMaxAge: 7200 }),
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T14:00:00Z"));
      expect(result.intervalSeconds).toBe(7200);
      expect(result.reason).toBe("cache_control");
    });

    it("clamps max-age below minimum to the cache-hint minimum", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({
          maxAge: MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS / 2,
        }),
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.nextFetchAt).toEqual(
        after(fixedNow, MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS)
      );
      expect(result.intervalSeconds).toBe(MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS);
      expect(result.reason).toBe("cache_control_clamped_min");
    });

    it("clamps max-age at exactly minimum", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS }),
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS);
      expect(result.reason).toBe("cache_control");
    });

    it("respects max-age between the cache-hint minimum and the general minimum", () => {
      const maxAge = (MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS + MIN_FETCH_INTERVAL_SECONDS) / 2;
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge }),
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(maxAge);
      expect(result.reason).toBe("cache_control");
    });

    it("clamps max-age above maximum to maximum", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: MAX_FETCH_INTERVAL_SECONDS * 2 }),
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.nextFetchAt).toEqual(after(fixedNow, MAX_FETCH_INTERVAL_SECONDS));
      expect(result.intervalSeconds).toBe(MAX_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("cache_control_clamped_max");
    });

    it("clamps max-age at exactly maximum", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: MAX_FETCH_INTERVAL_SECONDS }),
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(MAX_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("cache_control");
    });

    it("ignores no-store directive and uses default", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ noStore: true, maxAge: 3600 }),
        now: fixedNow,
        randomSource: noJitter,
      });

      // noStore returns undefined from getEffectiveMaxAge, so falls back to default
      expect(result.intervalSeconds).toBe(DEFAULT_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("default");
    });

    it("uses max-age=0 as minimum interval", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 0 }),
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS);
      expect(result.reason).toBe("cache_control_clamped_min");
    });
  });

  describe("with feed hints (TTL)", () => {
    it("uses RSS TTL when no cache headers present", () => {
      const result = calculateNextFetch({
        feedHints: { ttlMinutes: 120 }, // 2 hours
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T14:00:00Z"));
      expect(result.intervalSeconds).toBe(7200);
      expect(result.reason).toBe("ttl");
    });

    it("clamps TTL below minimum", () => {
      const result = calculateNextFetch({
        feedHints: { ttlMinutes: MIN_FETCH_INTERVAL_SECONDS / 60 / 2 },
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(MIN_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("ttl_clamped_min");
    });

    it("clamps TTL above maximum", () => {
      const result = calculateNextFetch({
        feedHints: { ttlMinutes: (MAX_FETCH_INTERVAL_SECONDS / 60) * 2 },
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(MAX_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("ttl_clamped_max");
    });

    it("cache headers take precedence over TTL", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 7200 }), // 2 hours
        feedHints: { ttlMinutes: 180 }, // 3 hours
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(7200); // Cache-Control wins
      expect(result.reason).toBe("cache_control");
    });

    it("ignores zero or negative TTL", () => {
      const result = calculateNextFetch({
        feedHints: { ttlMinutes: 0 },
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(DEFAULT_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("default");
    });
  });

  describe("with feed hints (syndication)", () => {
    it("uses syndication hints when no cache headers or TTL", () => {
      const result = calculateNextFetch({
        feedHints: {
          syndication: { updatePeriod: "daily", updateFrequency: 2 },
        },
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(12 * 60 * 60); // daily / 2 = 12 hours
      expect(result.reason).toBe("syndication");
    });

    it("clamps syndication below minimum", () => {
      const result = calculateNextFetch({
        feedHints: {
          syndication: { updatePeriod: "hourly", updateFrequency: 4 }, // 15 min
        },
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(MIN_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("syndication_clamped_min");
    });

    it("clamps syndication above maximum", () => {
      const result = calculateNextFetch({
        feedHints: {
          syndication: { updatePeriod: "yearly" },
        },
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(MAX_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("syndication_clamped_max");
    });

    it("TTL takes precedence over syndication", () => {
      const result = calculateNextFetch({
        feedHints: {
          ttlMinutes: 120, // 2 hours
          syndication: { updatePeriod: "daily" }, // 24 hours
        },
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(7200); // TTL wins
      expect(result.reason).toBe("ttl");
    });
  });

  describe("without any hints", () => {
    it("uses default interval when no hints", () => {
      const result = calculateNextFetch({
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.nextFetchAt).toEqual(after(fixedNow, DEFAULT_FETCH_INTERVAL_SECONDS));
      expect(result.intervalSeconds).toBe(DEFAULT_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("default");
    });

    it("uses default interval when cacheControl has no max-age", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl(), // no max-age
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(DEFAULT_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("default");
    });
  });

  describe("with failures (exponential backoff)", () => {
    it("uses the base failure backoff for 1 failure", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 1,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.nextFetchAt).toEqual(after(fixedNow, FAILURE_BASE_BACKOFF_SECONDS));
      expect(result.intervalSeconds).toBe(FAILURE_BASE_BACKOFF_SECONDS);
      expect(result.reason).toBe("failure_backoff");
    });

    it("caps backoff at the maximum interval for many failures", () => {
      const result = calculateNextFetch({
        consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(MAX_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("failure_backoff");
    });

    it("failure backoff takes precedence over all hints", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 3600 }),
        feedHints: { ttlMinutes: 60 },
        consecutiveFailures: 3,
        now: fixedNow,
        randomSource: noJitter,
      });

      // Should use failure backoff, not any hints
      expect(result.intervalSeconds).toBe(calculateFailureBackoff(3));
      expect(result.reason).toBe("failure_backoff");
    });

    it("zero failures does not trigger backoff", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 7200 }),
        consecutiveFailures: 0,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(7200);
      expect(result.reason).toBe("cache_control");
    });
  });

  describe("with Retry-After", () => {
    it("honors Retry-After as a floor when longer than the backoff", () => {
      const retryAfterSeconds = calculateFailureBackoff(1) * 4;
      const result = calculateNextFetch({
        consecutiveFailures: 1,
        retryAfterSeconds,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(retryAfterSeconds);
      expect(result.reason).toBe("failure_backoff");
    });

    it("keeps the exponential backoff when it exceeds Retry-After", () => {
      // A shorter Retry-After must not shrink the backoff.
      const result = calculateNextFetch({
        consecutiveFailures: 3,
        retryAfterSeconds: 60,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(calculateFailureBackoff(3));
      expect(result.reason).toBe("failure_backoff");
    });

    it("caps a very large Retry-After at the maximum interval", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 1,
        retryAfterSeconds: MAX_FETCH_INTERVAL_SECONDS * 2,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(MAX_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("failure_backoff");
    });

    it("ignores Retry-After on success (no failure to back off from)", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 7200 }),
        consecutiveFailures: 0,
        retryAfterSeconds: 30 * 24 * 60 * 60,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(7200);
      expect(result.reason).toBe("cache_control");
    });
  });

  describe("with rate-limited failures", () => {
    it("caps rate-limited backoff instead of escalating to the maximum interval", () => {
      // Many ordinary failures would hit the max; a chronically rate-limited
      // feed must keep retrying every few hours instead.
      const result = calculateNextFetch({
        consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
        rateLimited: true,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(RATE_LIMIT_MAX_BACKOFF_SECONDS);
      expect(result.reason).toBe("failure_backoff");
    });

    it("uses the ordinary ladder below the cap", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 3,
        rateLimited: true,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(calculateFailureBackoff(3)); // same as non-rate-limited
      expect(result.reason).toBe("failure_backoff");
    });

    it("honors a Retry-After larger than the rate-limit cap", () => {
      const result = calculateNextFetch({
        consecutiveFailures: MAX_CONSECUTIVE_FAILURES,
        rateLimited: true,
        retryAfterSeconds: RATE_LIMIT_MAX_BACKOFF_SECONDS * 2,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(RATE_LIMIT_MAX_BACKOFF_SECONDS * 2);
      expect(result.reason).toBe("failure_backoff");
    });
  });

  describe("with a plugin minimum interval", () => {
    it("raises the floor above a shorter cache hint", () => {
      // YouTube's max-age=900 would normally poll every 15 minutes; the
      // plugin floor holds it at an hour.
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 900 }),
        minIntervalSeconds: 60 * 60,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(60 * 60);
      expect(result.reason).toBe("cache_control_clamped_min");
    });

    it("does not lower a longer interval", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 4 * 60 * 60 }),
        minIntervalSeconds: 60 * 60,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(4 * 60 * 60);
      expect(result.reason).toBe("cache_control");
    });

    it("does not shorten the WebSub backup interval", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 900 }),
        minIntervalSeconds: 60 * 60,
        websubActive: true,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(WEBSUB_BACKUP_POLL_INTERVAL_SECONDS);
      expect(result.reason).toBe("websub_backup");
    });

    it("does not affect failure backoff", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 1,
        minIntervalSeconds: calculateFailureBackoff(1) * 2,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(calculateFailureBackoff(1));
      expect(result.reason).toBe("failure_backoff");
    });
  });

  describe("uses current time by default", () => {
    it("uses current time when now is not provided", () => {
      const before = new Date();
      const result = calculateNextFetch({ randomSource: noJitter });
      const after = new Date();

      const expectedMin = new Date(before.getTime() + DEFAULT_FETCH_INTERVAL_SECONDS * 1000);
      const expectedMax = new Date(after.getTime() + DEFAULT_FETCH_INTERVAL_SECONDS * 1000);

      expect(result.nextFetchAt.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
      expect(result.nextFetchAt.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
    });
  });

  describe("with jitter", () => {
    it("adds maximum jitter when randomSource returns 1", () => {
      const result = calculateNextFetch({
        now: fixedNow,
        randomSource: () => 1.0,
      });

      const expectedJitter = Math.floor(DEFAULT_FETCH_INTERVAL_SECONDS * DEFAULT_JITTER_FRACTION);
      expect(result.intervalSeconds).toBe(DEFAULT_FETCH_INTERVAL_SECONDS + expectedJitter);
    });

    it("caps jitter at MAX_JITTER_SECONDS for long intervals", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: MAX_FETCH_INTERVAL_SECONDS }), // 7 days
        now: fixedNow,
        randomSource: () => 1.0,
      });

      expect(result.intervalSeconds).toBe(MAX_FETCH_INTERVAL_SECONDS + MAX_JITTER_SECONDS);
    });

    it("jitter is applied to failure backoff too", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 2,
        now: fixedNow,
        randomSource: () => 1.0,
      });

      const backoff = calculateFailureBackoff(2);
      expect(result.intervalSeconds).toBe(backoff + calculateJitter(backoff, 1));
    });
  });
});

describe("calculateFailureBackoff", () => {
  it("starts at the base backoff and doubles per failure below the cutoff", () => {
    for (let failures = 1; failures < MAX_CONSECUTIVE_FAILURES; failures++) {
      expect(calculateFailureBackoff(failures)).toBe(
        FAILURE_BASE_BACKOFF_SECONDS * 2 ** (failures - 1)
      );
    }
  });

  it("stays within the max interval below the cutoff", () => {
    // Nothing clamps the doubling, so the cutoff has to come first.
    expect(calculateFailureBackoff(MAX_CONSECUTIVE_FAILURES - 1)).toBeLessThanOrEqual(
      MAX_FETCH_INTERVAL_SECONDS
    );
  });

  it("returns max interval at the cutoff and beyond", () => {
    expect(calculateFailureBackoff(MAX_CONSECUTIVE_FAILURES)).toBe(MAX_FETCH_INTERVAL_SECONDS);
    expect(calculateFailureBackoff(MAX_CONSECUTIVE_FAILURES + 1)).toBe(MAX_FETCH_INTERVAL_SECONDS);
    expect(calculateFailureBackoff(100)).toBe(MAX_FETCH_INTERVAL_SECONDS);
  });
});

describe("calculateJitter", () => {
  it("returns 0 when randomValue is 0", () => {
    expect(calculateJitter(3600, 0)).toBe(0);
  });

  it("returns the jitter fraction of short intervals with randomValue 1", () => {
    expect(calculateJitter(3600, 1)).toBe(Math.floor(3600 * DEFAULT_JITTER_FRACTION));
  });

  it("returns proportional jitter for intermediate randomValue", () => {
    expect(calculateJitter(3600, 0.5)).toBe(Math.floor(3600 * DEFAULT_JITTER_FRACTION * 0.5));
  });

  it("caps jitter at MAX_JITTER_SECONDS for long intervals", () => {
    expect(calculateJitter(MAX_FETCH_INTERVAL_SECONDS, 1)).toBe(MAX_JITTER_SECONDS);
  });

  it("caps jitter proportionally for long intervals", () => {
    expect(calculateJitter(MAX_FETCH_INTERVAL_SECONDS, 0.5)).toBe(MAX_JITTER_SECONDS / 2);
  });

  it("transitions smoothly at the cap threshold", () => {
    // The threshold where the jitter fraction of the interval equals MAX_JITTER_SECONDS
    const thresholdInterval = MAX_JITTER_SECONDS / DEFAULT_JITTER_FRACTION;

    // Just below threshold: proportional
    const belowThreshold = thresholdInterval - 1;
    expect(calculateJitter(belowThreshold, 1)).toBeLessThan(MAX_JITTER_SECONDS);

    // At threshold: exactly max
    expect(calculateJitter(thresholdInterval, 1)).toBe(MAX_JITTER_SECONDS);

    // Above threshold: still capped
    const aboveThreshold = thresholdInterval + 1000;
    expect(calculateJitter(aboveThreshold, 1)).toBe(MAX_JITTER_SECONDS);
  });
});

describe("shouldRefetchOnSubscribe", () => {
  const now = new Date("2024-06-01T12:00:00Z");

  it("returns true for a feed that has never been fetched", () => {
    expect(
      shouldRefetchOnSubscribe({ lastFetchedAt: null, nextFetchAt: null, websubActive: false }, now)
    ).toBe(true);
  });

  describe("normal (non-WebSub) feeds", () => {
    it("is not stale before it is due for its next poll", () => {
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const inThirtyMinutes = new Date(now.getTime() + 30 * 60 * 1000);
      expect(
        shouldRefetchOnSubscribe(
          { lastFetchedAt: oneHourAgo, nextFetchAt: inThirtyMinutes, websubActive: false },
          now
        )
      ).toBe(false);
    });

    it("is stale once it is due for its next poll", () => {
      const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const oneHourAgoDue = new Date(now.getTime() - 60 * 60 * 1000);
      expect(
        shouldRefetchOnSubscribe(
          { lastFetchedAt: twoHoursAgo, nextFetchAt: oneHourAgoDue, websubActive: false },
          now
        )
      ).toBe(true);
    });

    it("is stale when nextFetchAt is unknown", () => {
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      expect(
        shouldRefetchOnSubscribe(
          { lastFetchedAt: oneHourAgo, nextFetchAt: null, websubActive: false },
          now
        )
      ).toBe(true);
    });
  });

  describe("WebSub feeds", () => {
    // WebSub feeds ignore nextFetchAt (24h backup) and key off time since the
    // last real poll, bounded by the normal cache window.
    const cacheWindowMs = MIN_FETCH_INTERVAL_SECONDS * 1000;
    const backupNextFetch = new Date(now.getTime() + 20 * 60 * 60 * 1000); // 20h out

    it("is not stale within the cache window of the last real poll", () => {
      const justPolled = new Date(now.getTime() - cacheWindowMs / 2);
      expect(
        shouldRefetchOnSubscribe(
          { lastFetchedAt: justPolled, nextFetchAt: backupNextFetch, websubActive: true },
          now
        )
      ).toBe(false);
    });

    it("is stale once the last real poll is older than the cache window", () => {
      const staleFetch = new Date(now.getTime() - cacheWindowMs - 1000);
      expect(
        shouldRefetchOnSubscribe(
          { lastFetchedAt: staleFetch, nextFetchAt: backupNextFetch, websubActive: true },
          now
        )
      ).toBe(true);
    });
  });
});
