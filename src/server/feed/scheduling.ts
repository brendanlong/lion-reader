/**
 * Next fetch time scheduling utilities.
 * Pure functions for calculating when to next fetch a feed.
 */

import { type CacheControl, getEffectiveMaxAge } from "./cache-headers";

/** Minimum interval between fetches: 1 minute */
export const MIN_FETCH_INTERVAL_SECONDS = 60;

/** Maximum interval between fetches: 7 days */
export const MAX_FETCH_INTERVAL_SECONDS = 7 * 24 * 60 * 60; // 604800

/** Default interval when no cache headers: 15 minutes */
export const DEFAULT_FETCH_INTERVAL_SECONDS = 15 * 60; // 900

/** Maximum consecutive failures before permanent max backoff */
export const MAX_CONSECUTIVE_FAILURES = 10;

/** Base backoff time for failures: 30 minutes */
const FAILURE_BASE_BACKOFF_SECONDS = 30 * 60; // 1800

/**
 * Options for calculating the next fetch time.
 */
export interface CalculateNextFetchOptions {
  /** Parsed Cache-Control directives from the response */
  cacheControl?: CacheControl;
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
  | "default" // No cache headers, using default
  | "failure_backoff"; // Exponential backoff due to failures

/**
 * Calculates the next fetch time for a feed based on cache headers and failure count.
 *
 * Rules:
 * 1. If there are consecutive failures, use exponential backoff
 * 2. Otherwise, use Cache-Control max-age (clamped to bounds)
 * 3. If no cache headers, use default interval (15 minutes)
 *
 * Bounds:
 * - Minimum: 1 minute (never poll faster)
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
 * // With failures (exponential backoff)
 * calculateNextFetch({
 *   consecutiveFailures: 3,
 * })
 * // => { nextFetchAt: Date, intervalSeconds: 7200, reason: "failure_backoff" }
 *
 * @example
 * // No cache headers (default)
 * calculateNextFetch({})
 * // => { nextFetchAt: Date, intervalSeconds: 900, reason: "default" }
 */
export function calculateNextFetch(options: CalculateNextFetchOptions = {}): NextFetchResult {
  const { cacheControl, consecutiveFailures = 0, now = new Date() } = options;

  // If there are failures, use exponential backoff
  if (consecutiveFailures > 0) {
    const intervalSeconds = calculateFailureBackoff(consecutiveFailures);
    return {
      nextFetchAt: addSeconds(now, intervalSeconds),
      intervalSeconds,
      reason: "failure_backoff",
    };
  }

  // Try to use Cache-Control max-age
  if (cacheControl) {
    const effectiveMaxAge = getEffectiveMaxAge(cacheControl);

    if (effectiveMaxAge !== undefined) {
      // Clamp to bounds
      if (effectiveMaxAge < MIN_FETCH_INTERVAL_SECONDS) {
        return {
          nextFetchAt: addSeconds(now, MIN_FETCH_INTERVAL_SECONDS),
          intervalSeconds: MIN_FETCH_INTERVAL_SECONDS,
          reason: "cache_control_clamped_min",
        };
      }

      if (effectiveMaxAge > MAX_FETCH_INTERVAL_SECONDS) {
        return {
          nextFetchAt: addSeconds(now, MAX_FETCH_INTERVAL_SECONDS),
          intervalSeconds: MAX_FETCH_INTERVAL_SECONDS,
          reason: "cache_control_clamped_max",
        };
      }

      return {
        nextFetchAt: addSeconds(now, effectiveMaxAge),
        intervalSeconds: effectiveMaxAge,
        reason: "cache_control",
      };
    }
  }

  // Default: 15 minutes
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
