/**
 * Next fetch time scheduling utilities.
 * Pure functions for calculating when to next fetch a feed.
 */

import { type CacheControl, getEffectiveMaxAge } from "./cache-headers";
import type { SyndicationHints } from "./types";

/**
 * Default minimum interval between fetches: 60 minutes.
 * This can be overridden via the FEED_MIN_FETCH_INTERVAL_MINUTES environment variable.
 */
export const DEFAULT_MIN_FETCH_INTERVAL_SECONDS = 60 * 60; // 60 minutes

/**
 * Gets the configured minimum fetch interval in seconds.
 * Reads from FEED_MIN_FETCH_INTERVAL_MINUTES env var, defaults to 60 minutes.
 */
export function getMinFetchIntervalSeconds(): number {
  const envValue = process.env.FEED_MIN_FETCH_INTERVAL_MINUTES;
  if (envValue) {
    const minutes = parseInt(envValue, 10);
    if (!isNaN(minutes) && minutes > 0) {
      return minutes * 60;
    }
  }
  return DEFAULT_MIN_FETCH_INTERVAL_SECONDS;
}

/** Maximum interval between fetches: 7 days */
export const MAX_FETCH_INTERVAL_SECONDS = 7 * 24 * 60 * 60; // 604800

/** Default interval when no hints available: 60 minutes */
export const DEFAULT_FETCH_INTERVAL_SECONDS = 60 * 60; // 60 minutes

/** Maximum consecutive failures before permanent max backoff */
export const MAX_CONSECUTIVE_FAILURES = 10;

/** Base backoff time for failures: 30 minutes */
const FAILURE_BASE_BACKOFF_SECONDS = 30 * 60; // 1800

/**
 * Seconds per syndication period.
 */
const PERIOD_SECONDS: Record<NonNullable<SyndicationHints["updatePeriod"]>, number> = {
  hourly: 60 * 60,
  daily: 24 * 60 * 60,
  weekly: 7 * 24 * 60 * 60,
  monthly: 30 * 24 * 60 * 60,
  yearly: 365 * 24 * 60 * 60,
};

/**
 * Converts syndication hints to an interval in seconds.
 * Returns undefined if hints are invalid or incomplete.
 *
 * @example
 * // updatePeriod="daily", updateFrequency=2 means twice per day
 * // Interval = 24 hours / 2 = 12 hours
 * syndicationToSeconds({ updatePeriod: "daily", updateFrequency: 2 }) // 43200
 */
export function syndicationToSeconds(hints: SyndicationHints | undefined): number | undefined {
  if (!hints?.updatePeriod) {
    return undefined;
  }

  const periodSeconds = PERIOD_SECONDS[hints.updatePeriod];
  if (periodSeconds === undefined) {
    return undefined;
  }

  // Default frequency is 1 if not specified
  const frequency = hints.updateFrequency ?? 1;
  if (frequency <= 0) {
    return undefined;
  }

  // Interval = period / frequency
  return Math.floor(periodSeconds / frequency);
}

/**
 * Feed hints for scheduling extracted from the feed itself.
 */
export interface FeedHints {
  /** RSS 2.0 <ttl> element value in minutes */
  ttlMinutes?: number;
  /** Syndication namespace hints */
  syndication?: SyndicationHints;
}

/**
 * Options for calculating the next fetch time.
 */
export interface CalculateNextFetchOptions {
  /** Parsed Cache-Control directives from the response */
  cacheControl?: CacheControl;
  /** Feed-provided hints (TTL, syndication) */
  feedHints?: FeedHints;
  /** Number of consecutive fetch failures */
  consecutiveFailures?: number;
  /** The reference time to calculate from (defaults to now) */
  now?: Date;
}

/**
 * Result of next fetch calculation.
 */
export interface NextFetchResult {
  /** The calculated next fetch time */
  nextFetchAt: Date;
  /** The interval in seconds that was used */
  intervalSeconds: number;
  /** The reason for the chosen interval */
  reason: NextFetchReason;
}

/**
 * Reasons for the chosen fetch interval.
 */
export type NextFetchReason =
  | "cache_control" // Used Cache-Control max-age
  | "cache_control_clamped_min" // Cache-Control was below minimum, clamped up
  | "cache_control_clamped_max" // Cache-Control was above maximum, clamped down
  | "ttl" // Used RSS <ttl> element
  | "ttl_clamped_min" // TTL was below minimum, clamped up
  | "ttl_clamped_max" // TTL was above maximum, clamped down
  | "syndication" // Used syndication namespace hints
  | "syndication_clamped_min" // Syndication was below minimum, clamped up
  | "syndication_clamped_max" // Syndication was above maximum, clamped down
  | "default" // No hints available, using default
  | "failure_backoff"; // Exponential backoff due to failures

/**
 * Clamps a value to the configured bounds and returns the result with appropriate reason.
 */
function clampInterval(
  intervalSeconds: number,
  baseReason: "cache_control" | "ttl" | "syndication"
): { intervalSeconds: number; reason: NextFetchReason } {
  const minInterval = getMinFetchIntervalSeconds();

  if (intervalSeconds < minInterval) {
    return {
      intervalSeconds: minInterval,
      reason: `${baseReason}_clamped_min` as NextFetchReason,
    };
  }

  if (intervalSeconds > MAX_FETCH_INTERVAL_SECONDS) {
    return {
      intervalSeconds: MAX_FETCH_INTERVAL_SECONDS,
      reason: `${baseReason}_clamped_max` as NextFetchReason,
    };
  }

  return { intervalSeconds, reason: baseReason };
}

/**
 * Calculates the next fetch time for a feed based on various hints.
 *
 * Priority order:
 * 1. If there are consecutive failures, use exponential backoff
 * 2. Use Cache-Control max-age from HTTP response (clamped to bounds)
 * 3. Use feed hints: RSS <ttl> element or syndication namespace (clamped to bounds)
 * 4. If no hints available, use default interval (60 minutes)
 *
 * Bounds:
 * - Minimum: 60 minutes by default (configurable via FEED_MIN_FETCH_INTERVAL_MINUTES)
 * - Maximum: 7 days (always check eventually)
 * - Failures capped at 10 (then max backoff)
 *
 * @param options - Calculation options
 * @returns The next fetch result with time and reason
 *
 * @example
 * // With cache headers
 * calculateNextFetch({
 *   cacheControl: { maxAge: 3600, ... },
 * })
 * // => { nextFetchAt: Date, intervalSeconds: 3600, reason: "cache_control" }
 *
 * @example
 * // With feed TTL hint
 * calculateNextFetch({
 *   feedHints: { ttlMinutes: 120 },
 * })
 * // => { nextFetchAt: Date, intervalSeconds: 7200, reason: "ttl" }
 *
 * @example
 * // With syndication hints
 * calculateNextFetch({
 *   feedHints: { syndication: { updatePeriod: "daily", updateFrequency: 2 } },
 * })
 * // => { nextFetchAt: Date, intervalSeconds: 43200, reason: "syndication" }
 *
 * @example
 * // With failures (exponential backoff)
 * calculateNextFetch({
 *   consecutiveFailures: 3,
 * })
 * // => { nextFetchAt: Date, intervalSeconds: 7200, reason: "failure_backoff" }
 *
 * @example
 * // No hints (default)
 * calculateNextFetch({})
 * // => { nextFetchAt: Date, intervalSeconds: 3600, reason: "default" }
 */
export function calculateNextFetch(options: CalculateNextFetchOptions = {}): NextFetchResult {
  const { cacheControl, feedHints, consecutiveFailures = 0, now = new Date() } = options;

  // 1. If there are failures, use exponential backoff
  if (consecutiveFailures > 0) {
    const intervalSeconds = calculateFailureBackoff(consecutiveFailures);
    return {
      nextFetchAt: addSeconds(now, intervalSeconds),
      intervalSeconds,
      reason: "failure_backoff",
    };
  }

  // 2. Try to use Cache-Control max-age (HTTP headers take precedence)
  if (cacheControl) {
    const effectiveMaxAge = getEffectiveMaxAge(cacheControl);

    if (effectiveMaxAge !== undefined) {
      const { intervalSeconds, reason } = clampInterval(effectiveMaxAge, "cache_control");
      return {
        nextFetchAt: addSeconds(now, intervalSeconds),
        intervalSeconds,
        reason,
      };
    }
  }

  // 3. Try feed hints
  if (feedHints) {
    // 3a. Try RSS <ttl> element (value is in minutes)
    if (feedHints.ttlMinutes !== undefined && feedHints.ttlMinutes > 0) {
      const ttlSeconds = feedHints.ttlMinutes * 60;
      const { intervalSeconds, reason } = clampInterval(ttlSeconds, "ttl");
      return {
        nextFetchAt: addSeconds(now, intervalSeconds),
        intervalSeconds,
        reason,
      };
    }

    // 3b. Try syndication namespace hints
    const syndicationSeconds = syndicationToSeconds(feedHints.syndication);
    if (syndicationSeconds !== undefined) {
      const { intervalSeconds, reason } = clampInterval(syndicationSeconds, "syndication");
      return {
        nextFetchAt: addSeconds(now, intervalSeconds),
        intervalSeconds,
        reason,
      };
    }
  }

  // 4. Default: 60 minutes
  return {
    nextFetchAt: addSeconds(now, DEFAULT_FETCH_INTERVAL_SECONDS),
    intervalSeconds: DEFAULT_FETCH_INTERVAL_SECONDS,
    reason: "default",
  };
}

/**
 * Calculates the backoff interval for consecutive failures.
 *
 * Uses exponential backoff with base of 30 minutes:
 * - 1 failure: 30 minutes
 * - 2 failures: 1 hour
 * - 3 failures: 2 hours
 * - 4 failures: 4 hours
 * - 5 failures: 8 hours
 * - 6 failures: 16 hours
 * - 7 failures: 32 hours (~1.3 days)
 * - 8+ failures: 7 days (max)
 *
 * @param consecutiveFailures - Number of consecutive failures (1 or more)
 * @returns Backoff interval in seconds
 */
export function calculateFailureBackoff(consecutiveFailures: number): number {
  // Cap failures at MAX_CONSECUTIVE_FAILURES
  const cappedFailures = Math.min(consecutiveFailures, MAX_CONSECUTIVE_FAILURES);

  // At max failures, return max interval
  if (cappedFailures >= MAX_CONSECUTIVE_FAILURES) {
    return MAX_FETCH_INTERVAL_SECONDS;
  }

  // Exponential backoff: base * 2^(failures-1)
  const backoffSeconds = FAILURE_BASE_BACKOFF_SECONDS * Math.pow(2, cappedFailures - 1);

  // Cap at max interval
  return Math.min(backoffSeconds, MAX_FETCH_INTERVAL_SECONDS);
}

/**
 * Adds seconds to a date.
 *
 * @param date - The base date
 * @param seconds - Seconds to add
 * @returns New date with seconds added
 */
function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

/**
 * Simplified version that just returns the next fetch time.
 * Useful when you only need the Date and not the reasoning.
 *
 * @param options - Calculation options
 * @returns The next fetch time as a Date
 */
export function getNextFetchTime(options: CalculateNextFetchOptions = {}): Date {
  return calculateNextFetch(options).nextFetchAt;
}
