/**
 * Unit tests for next fetch time scheduling.
 */

import { describe, it, expect } from "vitest";
import {
  calculateNextFetch,
  calculateFailureBackoff,
  getNextFetchTime,
  MIN_FETCH_INTERVAL_SECONDS,
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

describe("calculateNextFetch", () => {
  const fixedNow = new Date("2024-01-15T12:00:00Z");

  describe("with cache headers", () => {
    it("respects Cache-Control max-age", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 3600 }), // 1 hour
        now: fixedNow,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T13:00:00Z"));
      expect(result.intervalSeconds).toBe(3600);
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

    it("clamps max-age below minimum to minimum (1 minute)", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 10 }), // 10 seconds
        now: fixedNow,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T12:01:00Z"));
      expect(result.intervalSeconds).toBe(MIN_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("cache_control_clamped_min");
    });

    it("clamps max-age at exactly minimum", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 60 }), // exactly 1 minute
        now: fixedNow,
      });

      expect(result.intervalSeconds).toBe(60);
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

      expect(result.intervalSeconds).toBe(MIN_FETCH_INTERVAL_SECONDS);
      expect(result.reason).toBe("cache_control_clamped_min");
    });
  });

  describe("without cache headers", () => {
    it("uses default interval (15 minutes) when no cache headers", () => {
      const result = calculateNextFetch({
        now: fixedNow,
      });

      expect(result.nextFetchAt).toEqual(new Date("2024-01-15T12:15:00Z"));
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

    it("uses 4 hour backoff for 4 failures", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 4,
        now: fixedNow,
      });

      expect(result.intervalSeconds).toBe(4 * 60 * 60); // 4 hours
      expect(result.reason).toBe("failure_backoff");
    });

    it("uses 8 hour backoff for 5 failures", () => {
      const result = calculateNextFetch({
        consecutiveFailures: 5,
        now: fixedNow,
      });

      expect(result.intervalSeconds).toBe(8 * 60 * 60); // 8 hours
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

    it("failure backoff takes precedence over cache headers", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 60 }), // 1 minute
        consecutiveFailures: 3,
        now: fixedNow,
      });

      // Should use failure backoff, not cache control
      expect(result.intervalSeconds).toBe(2 * 60 * 60); // 2 hours
      expect(result.reason).toBe("failure_backoff");
    });

    it("zero failures does not trigger backoff", () => {
      const result = calculateNextFetch({
        cacheControl: createCacheControl({ maxAge: 3600 }),
        consecutiveFailures: 0,
        now: fixedNow,
      });

      expect(result.intervalSeconds).toBe(3600);
      expect(result.reason).toBe("cache_control");
    });
  });

  describe("uses current time by default", () => {
    it("uses current time when now is not provided", () => {
      const before = new Date();
      const result = calculateNextFetch({});
      const after = new Date();

      // The nextFetchAt should be between (before + 15min) and (after + 15min)
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

  it("returns 16 hours for 6 failures", () => {
    expect(calculateFailureBackoff(6)).toBe(16 * 60 * 60);
  });

  it("returns 32 hours for 7 failures", () => {
    expect(calculateFailureBackoff(7)).toBe(32 * 60 * 60);
  });

  it("returns 64 hours for 8 failures", () => {
    expect(calculateFailureBackoff(8)).toBe(64 * 60 * 60);
  });

  it("returns 128 hours for 9 failures", () => {
    // 30 * 2^8 = 7680 minutes = 460800 seconds
    // This is less than 7 days (604800 seconds)
    expect(calculateFailureBackoff(9)).toBe(128 * 60 * 60);
  });

  it("returns max interval for 10 failures", () => {
    expect(calculateFailureBackoff(10)).toBe(MAX_FETCH_INTERVAL_SECONDS);
  });

  it("returns max interval for failures beyond 10", () => {
    expect(calculateFailureBackoff(11)).toBe(MAX_FETCH_INTERVAL_SECONDS);
    expect(calculateFailureBackoff(100)).toBe(MAX_FETCH_INTERVAL_SECONDS);
    expect(calculateFailureBackoff(1000)).toBe(MAX_FETCH_INTERVAL_SECONDS);
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
      cacheControl: createCacheControl({ maxAge: 3600 }),
      now: fixedNow,
    });

    expect(result).toEqual(new Date("2024-01-15T13:00:00Z"));
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
  it("MIN_FETCH_INTERVAL_SECONDS is 1 minute", () => {
    expect(MIN_FETCH_INTERVAL_SECONDS).toBe(60);
  });

  it("MAX_FETCH_INTERVAL_SECONDS is 7 days", () => {
    expect(MAX_FETCH_INTERVAL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  it("DEFAULT_FETCH_INTERVAL_SECONDS is 15 minutes", () => {
    expect(DEFAULT_FETCH_INTERVAL_SECONDS).toBe(15 * 60);
  });

  it("MAX_CONSECUTIVE_FAILURES is 10", () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(10);
  });
});

describe("real-world scenarios", () => {
  const fixedNow = new Date("2024-01-15T12:00:00Z");

  it("typical blog with 1 hour cache", () => {
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 3600, public: true }),
      now: fixedNow,
    });

    expect(result.intervalSeconds).toBe(3600);
    expect(result.reason).toBe("cache_control");
  });

  it("high-frequency news feed with 5 minute cache", () => {
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 300, public: true }),
      now: fixedNow,
    });

    expect(result.intervalSeconds).toBe(300);
    expect(result.reason).toBe("cache_control");
  });

  it("infrequently updated feed with 1 day cache", () => {
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 86400, public: true }),
      now: fixedNow,
    });

    expect(result.intervalSeconds).toBe(86400);
    expect(result.reason).toBe("cache_control");
  });

  it("aggressive cache control (30 seconds) gets clamped to 1 minute", () => {
    const result = calculateNextFetch({
      cacheControl: createCacheControl({ maxAge: 30 }),
      now: fixedNow,
    });

    expect(result.intervalSeconds).toBe(60);
    expect(result.reason).toBe("cache_control_clamped_min");
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
      cacheControl: createCacheControl({ maxAge: 1800 }), // 30 minutes
      consecutiveFailures: 0,
      now: fixedNow,
    });

    expect(result.intervalSeconds).toBe(1800);
    expect(result.reason).toBe("cache_control");
  });
});
