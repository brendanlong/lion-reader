/**
 * Unit tests for next fetch time scheduling.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  calculateNextFetch,
  calculateFailureBackoff,
  getNextFetchTime,
  syndicationToSeconds,
  getMinFetchIntervalSeconds,
  DEFAULT_MIN_FETCH_INTERVAL_SECONDS,
  MAX_FETCH_INTERVAL_SECONDS,
  DEFAULT_FETCH_INTERVAL_SECONDS,
  MAX_CONSECUTIVE_FAILURES,
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
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T14:00:00Z"));
      expect(result.intervalSeconds).toBe(7200);
      expect(result.reason).toBe("cache_control");
    });

    it("respects s-maxage over max-age", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 3600, sMaxAge: 7200 }),
        now: fixedNow,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T14:00:00Z"));
      expect(result.intervalSeconds).toBe(7200);
      expect(result.reason).toBe("cache_control");
    });

    it("clamps max-age below minimum to minimum (60 minutes)", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 300 }), // 5 minutes
        now: fixedNow,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T13:00:00Z")); // 60 min later
      expect(result.intervalSeconds).toBe(60 * 60);
      expect(result.reason).toBe("cache_control_clamped_min");
    });

    it("clamps max-age at exactly minimum", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 3600 }), // exactly 60 minutes
        now: fixedNow,
      });

      expect(result.intervalSeconds).toBe(3600);
      expect(result.reason).toBe("cache_control");
    });

    it("clamps max-age above maximum to maximum (7 days)", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 86400 * 30 }), // 30 days
        now: fixedNow,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-22T12:00:00Z")); // 7 days later
      expect(result.intervalSeconds).toBe(MAX_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("cache_control_clamped_max");
    });

    it("clamps max-age at exactly maximum", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 604800 }), // exactly 7 days
        now: fixedNow,
      });

      expect(result.intervalSeconds).toBe(604800);
      expect(result.reason).toBe("cache_control");
    });

    it("ignores no-store directive and uses default", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ noStore: true, maxAge: 3600 }),
        now: fixedNow,
      });

      // noStore returns undefined from getEffectiveMaxAge, so falls back to default
      expect(result.intervalSeconds).toBe(DEFAULT_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("default");
    });

    it("uses max-age=0 as minimum interval", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 0 }),
        now: fixedNow,
      });

      expect(result.intervalSeconds).toBe(getMinFetchIntervalSeconds());
      expect(result.reason).toBe("cache_control_clamped_min");
    });
  });

  describe("with feed hints (TTL)", () => {
    it("uses RSS TTL when no cache headers present", () => {
      const result = calculateNextFetch({
        feedHints: { ttlMinutes: 120 }, // 2 hours
        now: fixedNow,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T14:00:00Z"));
      expect(result.intervalSeconds).toBe(7200);
      expect(result.reason).toBe("ttl");
    });

    it("clamps TTL below minimum", () => {
      const result = calculateNextFetch({
        feedHints: { ttlMinutes: 15 }, // 15 minutes, below 60 min minimum
        now: fixedNow,
      });

      expect(result.intervalSeconds).toBe(getMinFetchIntervalSeconds());
      expect(result.reason).toBe("ttl_clamped_min");
    });

    it("clamps TTL above maximum", () => {
      const result = calculateNextFetch({
        feedHints: { ttlMinutes: 60 * 24 * 30 }, // 30 days
        now: fixedNow,
      });

      expect(result.intervalSeconds).toBe(MAX_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("ttl_clamped_max");
    });

    it("cache headers take precedence over TTL", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 7200 }), // 2 hours
        feedHints: { ttlMinutes: 180 }, // 3 hours
        now: fixedNow,
      });

      expect(result.intervalSeconds).toBe(7200); // Cache-Control wins
      expect(result.reason).toBe("cache_control");
    });

    it("ignores zero or negative TTL", () => {
      const result = calculateNextFetch({
        feedHints: { ttlMinutes: 0 },
        now: fixedNow,
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
      });

      expect(result.intervalSeconds).toBe(7200); // TTL wins
      expect(result.reason).toBe("ttl");
    });
  });

  describe("without any hints", () => {
    it("uses default interval (60 minutes) when no hints", () => {
      const result = calculateNextFetch({
        now: fixedNow,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T13:00:00Z"));
      expect(result.intervalSeconds).toBe(DEFAULT_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("default");
    });

    it("uses default interval when cacheControl is undefined", () => {
      const result = calculateNextFetch({
        cacheControl: undefined,
        now: fixedNow,
      });

      expect(result.intervalSeconds).toBe(DEFAULT_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("default");
    });

    it("uses default interval when cacheControl has no max-age", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ public: true }), // no max-age
        now: fixedNow,
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
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T12:30:00Z"));
      expect(result.intervalSeconds).toBe(30 * 60); // 30 minutes
      expect(result.reason).toBe("failure_backoff");
    });

    it("uses 1 hour backoff for 2 failures", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 2,
        now: fixedNow,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T13:00:00Z"));
      expect(result.intervalSeconds).toBe(60 * 60); // 1 hour
      expect(result.reason).toBe("failure_backoff");
    });

    it("uses 2 hour backoff for 3 failures", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 3,
        now: fixedNow,
      });

      expect(result.intervalSeconds).toBe(2 * 60 * 60); // 2 hours
      expect(result.reason).toBe("failure_backoff");
    });

    it("caps backoff at 7 days for 10 failures", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 10,
        now: fixedNow,
      });

      expect(result.intervalSeconds).toBe(MAX_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("failure_backoff");
    });

    it("caps backoff at 7 days for more than 10 failures", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 50,
        now: fixedNow,
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
      });

      expect(result.intervalSeconds).toBe(7200);
      expect(result.reason).toBe("cache_control");
    });
  });

  describe("uses current time by default", () => {
    it("uses current time when now is not provided", () => {
      const before = new Date();
      const result = calculateNextFetch({});
      const after = new Date();

      const expectedMin = new Date(before.getTime() + DEFAULT_FETCH_INTERVAL_SECONDS * 1000);
      const expectedMax = new Date(after.getTime() + DEFAULT_FETCH_INTERVAL_SECONDS * 1000);

      expect(result.nextFetchAt.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
      expect(result.nextFetchAt.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
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

  it("follows exponential pattern 30 * 2^(n-1)", () => {
    for (let i = 1; i <= 9; i++) {
      const expected = Math.min(30 * 60 * Math.pow(2, i - 1), MAX_FETCH_INTERVAL_SECONDS);
      expect(calculateFailureBackoff(i)).toBe(expected);
    }
  });
});

describe("getNextFetchTime", () => {
  const fixedNow = new Date("2024-01-15T12:00:00Z");

  it("returns just the Date without metadata", () => {
    const result = getNextFetchTime({
      cacheControl: createCacheControl({ maxAge: 7200 }),
      now: fixedNow,
    });

    expect(result).toEqual(new Date("2024-01-15T14:00:00Z"));
    expect(result).toBeInstanceOf(Date);
  });

  it("uses default interval when no options", () => {
    const before = new Date();
    const result = getNextFetchTime();
    const after = new Date();

    const expectedMin = new Date(before.getTime() + DEFAULT_FETCH_INTERVAL_SECONDS * 1000);
    const expectedMax = new Date(after.getTime() + DEFAULT_FETCH_INTERVAL_SECONDS * 1000);

    expect(result.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime());
    expect(result.getTime()).toBeLessThanOrEqual(expectedMax.getTime());
  });
});

describe("constants", () => {
  it("DEFAULT_MIN_FETCH_INTERVAL_SECONDS is 60 minutes", () => {
    expect(DEFAULT_MIN_FETCH_INTERVAL_SECONDS).toBe(60 * 60);
  });

  it("MAX_FETCH_INTERVAL_SECONDS is 7 days", () => {
    expect(MAX_FETCH_INTERVAL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it("DEFAULT_FETCH_INTERVAL_SECONDS is 60 minutes", () => {
    expect(DEFAULT_FETCH_INTERVAL_SECONDS).toBe(60 * 60);
  });

  it("MAX_CONSECUTIVE_FAILURES is 10", () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(10);
  });
});

describe("real-world scenarios", () => {
  const fixedNow = new Date("2024-01-15T12:00:00Z");

  it("typical blog with 2 hour cache", () => {
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 7200, public: true }),
      now: fixedNow,
    });

    expect(result.intervalSeconds).toBe(7200);
    expect(result.reason).toBe("cache_control");
  });

  it("high-frequency news feed with 5 minute cache gets clamped to 60 min", () => {
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 300, public: true }),
      now: fixedNow,
    });

    expect(result.intervalSeconds).toBe(60 * 60); // Clamped to minimum
    expect(result.reason).toBe("cache_control_clamped_min");
  });

  it("infrequently updated feed with 1 day cache", () => {
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 86400, public: true }),
      now: fixedNow,
    });

    expect(result.intervalSeconds).toBe(86400);
    expect(result.reason).toBe("cache_control");
  });

  it("feed with TTL of 90 minutes", () => {
    const result = calculateNextFetch({
      feedHints: { ttlMinutes: 90 },
      now: fixedNow,
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
    });

    expect(result.intervalSeconds).toBe(7 * 24 * 60 * 60);
    expect(result.reason).toBe("syndication");
  });

  it("extremely long cache (1 year) gets clamped to 7 days", () => {
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 365 * 24 * 60 * 60 }),
      now: fixedNow,
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
    });

    expect(result.intervalSeconds).toBe(7200);
    expect(result.reason).toBe("cache_control");
  });
});
