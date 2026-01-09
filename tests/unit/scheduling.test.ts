/**
 * Unit tests for next fetch time scheduling.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  calculateNextFetch,
  calculateFailureBackoff,
  calculateJitter,
  getNextFetchTime,
  syndicationToSeconds,
  getMinFetchIntervalSeconds,
  MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS,
  MAX_FETCH_INTERVAL_SECONDS,
  DEFAULT_FETCH_INTERVAL_SECONDS,
  DEFAULT_JITTER_FRACTION,
  MAX_JITTER_SECONDS,
} from "../../src/server/feed/scheduling";
import type { CacheControl } from "../../src/server/feed/cache-headers";

/**
 * Helper to create a CacheControl object with defaults.
 */
function createCacheControl(overrides: Partial<CacheControl> = {}): CacheControl {
  return {
    noStore: false,
    noCache: false,
    private: false,
    public: false,
    mustRevalidate: false,
    immutable: false,
    ...overrides,
  };
}

/**
 * Returns a random source that always returns 0 (no jitter).
 * Use this for deterministic tests that check exact interval values.
 */
const noJitter = () => 0;

describe("getMinFetchIntervalSeconds", () => {
  const originalEnv = process.env.FEED_MIN_FETCH_INTERVAL_MINUTES;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FEED_MIN_FETCH_INTERVAL_MINUTES;
    } else {
      process.env.FEED_MIN_FETCH_INTERVAL_MINUTES = originalEnv;
    }
  });

  it("returns default (60 minutes) when env var not set", () => {
    delete process.env.FEED_MIN_FETCH_INTERVAL_MINUTES;
    expect(getMinFetchIntervalSeconds()).toBe(60 * 60);
  });

  it("reads from FEED_MIN_FETCH_INTERVAL_MINUTES env var", () => {
    process.env.FEED_MIN_FETCH_INTERVAL_MINUTES = "30";
    expect(getMinFetchIntervalSeconds()).toBe(30 * 60);
  });

  it("ignores invalid env var values", () => {
    process.env.FEED_MIN_FETCH_INTERVAL_MINUTES = "invalid";
    expect(getMinFetchIntervalSeconds()).toBe(60 * 60);
  });

  it("ignores zero or negative values", () => {
    process.env.FEED_MIN_FETCH_INTERVAL_MINUTES = "0";
    expect(getMinFetchIntervalSeconds()).toBe(60 * 60);

    process.env.FEED_MIN_FETCH_INTERVAL_MINUTES = "-5";
    expect(getMinFetchIntervalSeconds()).toBe(60 * 60);
  });
});

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

  it("defaults frequency to 1 when not specified", () => {
    expect(syndicationToSeconds({ updatePeriod: "daily" })).toBe(24 * 60 * 60);
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

    it("clamps max-age below minimum to minimum (10 minutes for cache headers)", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 300 }), // 5 minutes
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T12:10:00Z")); // 10 min later
      expect(result.intervalSeconds).toBe(MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS);
      expect(result.reason).toBe("cache_control_clamped_min");
    });

    it("clamps max-age at exactly minimum (10 minutes)", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 600 }), // exactly 10 minutes
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS);
      expect(result.reason).toBe("cache_control");
    });

    it("respects max-age between 10 and 60 minutes", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 1800 }), // 30 minutes
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(1800);
      expect(result.reason).toBe("cache_control");
    });

    it("clamps max-age above maximum to maximum (7 days)", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 86400 * 30 }), // 30 days
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-22T12:00:00Z")); // 7 days later
      expect(result.intervalSeconds).toBe(MAX_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("cache_control_clamped_max");
    });

    it("clamps max-age at exactly maximum", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 604800 }), // exactly 7 days
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(604800);
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

    it("uses max-age=0 as minimum interval (10 minutes)", () => {
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
        feedHints: { ttlMinutes: 15 }, // 15 minutes, below 60 min minimum
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(getMinFetchIntervalSeconds());
      expect(result.reason).toBe("ttl_clamped_min");
    });

    it("clamps TTL above maximum", () => {
      const result = calculateNextFetch({
        feedHints: { ttlMinutes: 60 * 24 * 30 }, // 30 days
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

      expect(result.intervalSeconds).toBe(getMinFetchIntervalSeconds());
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
    it("uses default interval (60 minutes) when no hints", () => {
      const result = calculateNextFetch({
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T13:00:00Z"));
      expect(result.intervalSeconds).toBe(DEFAULT_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("default");
    });

    it("uses default interval when cacheControl is undefined", () => {
      const result = calculateNextFetch({
        cacheControl: undefined,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(DEFAULT_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("default");
    });

    it("uses default interval when cacheControl has no max-age", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ public: true }), // no max-age
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(DEFAULT_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("default");
    });
  });

  describe("with failures (exponential backoff)", () => {
    it("uses 30 minute backoff for 1 failure", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 1,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T12:30:00Z"));
      expect(result.intervalSeconds).toBe(30 * 60); // 30 minutes
      expect(result.reason).toBe("failure_backoff");
    });

    it("uses 1 hour backoff for 2 failures", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 2,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T13:00:00Z"));
      expect(result.intervalSeconds).toBe(60 * 60); // 1 hour
      expect(result.reason).toBe("failure_backoff");
    });

    it("uses 2 hour backoff for 3 failures", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 3,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(2 * 60 * 60); // 2 hours
      expect(result.reason).toBe("failure_backoff");
    });

    it("caps backoff at 7 days for 10 failures", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 10,
        now: fixedNow,
        randomSource: noJitter,
      });

      expect(result.intervalSeconds).toBe(MAX_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("failure_backoff");
    });

    it("caps backoff at 7 days for more than 10 failures", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 50,
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
      expect(result.intervalSeconds).toBe(2 * 60 * 60); // 2 hours
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
    it("adds jitter based on randomSource", () => {
      const result = calculateNextFetch({
        now: fixedNow,
        randomSource: () => 0.5, // 50% of max jitter
      });

      // Default interval is 60 min, 10% jitter = 6 min max, 50% of that = 3 min
      const expectedJitter = Math.floor(
        DEFAULT_FETCH_INTERVAL_SECONDS * DEFAULT_JITTER_FRACTION * 0.5
      );
      expect(result.intervalSeconds).toBe(DEFAULT_FETCH_INTERVAL_SECONDS + expectedJitter);
    });

    it("adds maximum jitter when randomSource returns 1", () => {
      const result = calculateNextFetch({
        now: fixedNow,
        randomSource: () => 1.0,
      });

      // Default interval is 60 min, 10% jitter = 6 min max
      const expectedJitter = Math.floor(DEFAULT_FETCH_INTERVAL_SECONDS * DEFAULT_JITTER_FRACTION);
      expect(result.intervalSeconds).toBe(DEFAULT_FETCH_INTERVAL_SECONDS + expectedJitter);
    });

    it("caps jitter at MAX_JITTER_SECONDS for long intervals", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: MAX_FETCH_INTERVAL_SECONDS }), // 7 days
        now: fixedNow,
        randomSource: () => 1.0,
      });

      // 7 days with 10% jitter would be 16.8 hours, but capped at 30 min
      expect(result.intervalSeconds).toBe(MAX_FETCH_INTERVAL_SECONDS + MAX_JITTER_SECONDS);
    });

    it("uses proportional jitter for short intervals", () => {
      // For a 2 hour interval, 10% = 12 min, which is less than 30 min cap
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 7200 }), // 2 hours
        now: fixedNow,
        randomSource: () => 1.0,
      });

      const expectedJitter = Math.floor(7200 * DEFAULT_JITTER_FRACTION); // 720 seconds = 12 min
      expect(result.intervalSeconds).toBe(7200 + expectedJitter);
    });

    it("jitter is proportional to random value", () => {
      const results = [0, 0.25, 0.5, 0.75, 1.0].map(
        (random) =>
          calculateNextFetch({
            now: fixedNow,
            randomSource: () => random,
          }).intervalSeconds
      );

      // Each result should be larger than the previous
      for (let i = 1; i < results.length; i++) {
        expect(results[i]).toBeGreaterThan(results[i - 1]);
      }
    });

    it("jitter is applied to failure backoff too", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 2, // 1 hour backoff
        now: fixedNow,
        randomSource: () => 1.0,
      });

      // 1 hour backoff, 10% jitter = 6 min max
      const expectedJitter = Math.floor(60 * 60 * DEFAULT_JITTER_FRACTION);
      expect(result.intervalSeconds).toBe(60 * 60 + expectedJitter);
    });
  });
});

describe("calculateFailureBackoff", () => {
  it("returns 30 minutes for 1 failure", () => {
    expect(calculateFailureBackoff(1)).toBe(30 * 60);
  });

  it("returns 1 hour for 2 failures", () => {
    expect(calculateFailureBackoff(2)).toBe(60 * 60);
  });

  it("returns 2 hours for 3 failures", () => {
    expect(calculateFailureBackoff(3)).toBe(2 * 60 * 60);
  });

  it("returns 4 hours for 4 failures", () => {
    expect(calculateFailureBackoff(4)).toBe(4 * 60 * 60);
  });

  it("returns 8 hours for 5 failures", () => {
    expect(calculateFailureBackoff(5)).toBe(8 * 60 * 60);
  });

  it("returns max interval for 10 failures", () => {
    expect(calculateFailureBackoff(10)).toBe(MAX_FETCH_INTERVAL_SECONDS);
  });

  it("returns max interval for failures beyond 10", () => {
    expect(calculateFailureBackoff(11)).toBe(MAX_FETCH_INTERVAL_SECONDS);
    expect(calculateFailureBackoff(100)).toBe(MAX_FETCH_INTERVAL_SECONDS);
  });

  it("follows exponential pattern", () => {
    // Use hardcoded expected values to avoid duplicating the implementation logic
    const expectedBackoffs: Record<number, number> = {
      1: 1800, // 30 min
      2: 3600, // 1 hour
      3: 7200, // 2 hours
      4: 14400, // 4 hours
      5: 28800, // 8 hours
      6: 57600, // 16 hours
      7: 115200, // 32 hours
      8: 230400, // 64 hours
      9: 460800, // 128 hours
    };

    for (const [failures, expected] of Object.entries(expectedBackoffs)) {
      expect(calculateFailureBackoff(Number(failures))).toBe(expected);
    }
  });
});

describe("getNextFetchTime", () => {
  const fixedNow = new Date("2024-01-15T12:00:00Z");

  it("returns just the Date without metadata", () => {
    const result = getNextFetchTime({
      cacheControl: createCacheControl({ maxAge: 7200 }),
      now: fixedNow,
      randomSource: noJitter,
    });

    expect(result).toEqual(new Date("2024-01-15T14:00:00Z"));
    expect(result).toBeInstanceOf(Date);
  });

  it("uses default interval when no options", () => {
    const before = new Date();
    const result = getNextFetchTime({ randomSource: noJitter });
    const after = new Date();

    const expectedMin = new Date(before.getTime() + DEFAULT_FETCH_INTERVAL_SECONDS * 1000);
    const expectedMax = new Date(after.getTime() + DEFAULT_FETCH_INTERVAL_SECONDS * 1000);

    expect(result.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
    expect(result.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
  });
});

describe("real-world scenarios", () => {
  const fixedNow = new Date("2024-01-15T12:00:00Z");

  it("typical blog with 2 hour cache", () => {
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 7200, public: true }),
      now: fixedNow,
      randomSource: noJitter,
    });

    expect(result.intervalSeconds).toBe(7200);
    expect(result.reason).toBe("cache_control");
  });

  it("high-frequency news feed with 5 minute cache gets clamped to 10 min", () => {
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 300, public: true }),
      now: fixedNow,
      randomSource: noJitter,
    });

    expect(result.intervalSeconds).toBe(MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS); // Clamped to 10 min minimum
    expect(result.reason).toBe("cache_control_clamped_min");
  });

  it("cache headers allow 15-minute polling when server specifies it", () => {
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 900, public: true }), // 15 minutes
      now: fixedNow,
      randomSource: noJitter,
    });

    expect(result.intervalSeconds).toBe(900); // Allowed because server explicitly said so
    expect(result.reason).toBe("cache_control");
  });

  it("TTL hint of 15 minutes still gets clamped to 60 min (less trusted)", () => {
    const result = calculateNextFetch({
      feedHints: { ttlMinutes: 15 }, // 15 minutes
      now: fixedNow,
      randomSource: noJitter,
    });

    expect(result.intervalSeconds).toBe(getMinFetchIntervalSeconds()); // Clamped to 60 min
    expect(result.reason).toBe("ttl_clamped_min");
  });

  it("infrequently updated feed with 1 day cache", () => {
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 86400, public: true }),
      now: fixedNow,
      randomSource: noJitter,
    });

    expect(result.intervalSeconds).toBe(86400);
    expect(result.reason).toBe("cache_control");
  });

  it("feed with TTL of 90 minutes", () => {
    const result = calculateNextFetch({
      feedHints: { ttlMinutes: 90 },
      now: fixedNow,
      randomSource: noJitter,
    });

    expect(result.intervalSeconds).toBe(90 * 60);
    expect(result.reason).toBe("ttl");
  });

  it("feed with daily syndication updates twice per day", () => {
    const result = calculateNextFetch({
      feedHints: {
        syndication: { updatePeriod: "daily", updateFrequency: 2 },
      },
      now: fixedNow,
      randomSource: noJitter,
    });

    expect(result.intervalSeconds).toBe(12 * 60 * 60); // 12 hours
    expect(result.reason).toBe("syndication");
  });

  it("feed with weekly syndication", () => {
    const result = calculateNextFetch({
      feedHints: {
        syndication: { updatePeriod: "weekly" },
      },
      now: fixedNow,
      randomSource: noJitter,
    });

    expect(result.intervalSeconds).toBe(7 * 24 * 60 * 60);
    expect(result.reason).toBe("syndication");
  });

  it("extremely long cache (1 year) gets clamped to 7 days", () => {
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 365 * 24 * 60 * 60 }),
      now: fixedNow,
      randomSource: noJitter,
    });

    expect(result.intervalSeconds).toBe(7 * 24 * 60 * 60);
    expect(result.reason).toBe("cache_control_clamped_max");
  });

  it("feed with intermittent failures gradually backs off", () => {
    // Simulate a feed that keeps failing
    const intervals = [1, 2, 3, 4, 5].map(
      (failures) =>
        calculateNextFetch({
          consecutiveFailures: failures,
          now: fixedNow,
          randomSource: noJitter,
        }).intervalSeconds
    );

    // Each interval should be double the previous
    expect(intervals[1]).toBe(intervals[0] * 2);
    expect(intervals[2]).toBe(intervals[1] * 2);
    expect(intervals[3]).toBe(intervals[2] * 2);
    expect(intervals[4]).toBe(intervals[3] * 2);
  });

  it("feed recovery after failures uses cache headers again", () => {
    // After failures are resolved (consecutiveFailures = 0),
    // should use cache headers again
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 7200 }), // 2 hours
      consecutiveFailures: 0,
      now: fixedNow,
      randomSource: noJitter,
    });

    expect(result.intervalSeconds).toBe(7200);
    expect(result.reason).toBe("cache_control");
  });
});

describe("calculateJitter", () => {
  it("returns 0 when randomValue is 0", () => {
    expect(calculateJitter(3600, 0)).toBe(0);
  });

  it("returns 10% of interval for short intervals with randomValue 1", () => {
    // 60 min interval, 10% = 6 min = 360 seconds
    expect(calculateJitter(3600, 1)).toBe(360);
  });

  it("returns proportional jitter for intermediate randomValue", () => {
    // 60 min interval, 10% = 6 min, 50% of that = 3 min = 180 seconds
    expect(calculateJitter(3600, 0.5)).toBe(180);
  });

  it("caps jitter at MAX_JITTER_SECONDS for long intervals", () => {
    // 7 day interval, 10% would be 16.8 hours, but capped at 30 min
    expect(calculateJitter(MAX_FETCH_INTERVAL_SECONDS, 1)).toBe(MAX_JITTER_SECONDS);
  });

  it("caps jitter proportionally for long intervals", () => {
    // 7 day interval with randomValue 0.5 should be 15 min (half of 30 min cap)
    expect(calculateJitter(MAX_FETCH_INTERVAL_SECONDS, 0.5)).toBe(MAX_JITTER_SECONDS / 2);
  });

  it("uses proportional jitter below the cap threshold", () => {
    // 5 hour interval: 10% = 30 min, exactly at the cap
    // Just below: 4 hour interval: 10% = 24 min (below cap)
    const fourHours = 4 * 60 * 60;
    expect(calculateJitter(fourHours, 1)).toBe(Math.floor(fourHours * DEFAULT_JITTER_FRACTION));
  });

  it("transitions smoothly at the cap threshold", () => {
    // Find the threshold where 10% of interval equals MAX_JITTER_SECONDS
    // MAX_JITTER_SECONDS / 0.1 = 18000 seconds = 5 hours
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
