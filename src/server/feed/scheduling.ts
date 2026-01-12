/**
 * Next fetch time scheduling utilities.
 * Pure functions for calculating when to next fetch a feed.
 */

import { type CacheControl, getEffectiveMaxAge } from "./cache-headers";
import type { SyndicationHints } from "./types";

/**
 * Default minimum interval between fetches: 60 minutes.
 * This is used when no cache headers are provided (TTL, syndication, or no hints).
 * This can be overridden via the FEED_MIN_FETCH_INTERVAL_MINUTES environment variable.
 */
const DEFAULT_MIN_FETCH_INTERVAL_SECONDS = 60 * 60; // 60 minutes

/**
 * Minimum interval when server explicitly provides cache headers: 10 minutes.
 * We trust server-provided cache directives more than feed hints, so we allow
 * faster polling when the server explicitly tells us to.
 */
export const MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS = 10 * 60; // 10 minutes

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

/**
 * Backup polling interval when WebSub is active: 24 hours.
 * WebSub provides real-time push notifications, so we only need infrequent
 * polling as a backup in case WebSub stops working.
 */
export const WEBSUB_BACKUP_POLL_INTERVAL_SECONDS = 24 * 60 * 60; // 86400

/** Default interval when no hints available: 60 minutes */
export const DEFAULT_FETCH_INTERVAL_SECONDS = 60 * 60; // 60 minutes

/** Default jitter fraction: 10% of interval */
export const DEFAULT_JITTER_FRACTION = 0.1;

/** Maximum jitter: 30 minutes (prevents long-interval feeds from being too delayed) */
export const MAX_JITTER_SECONDS = 30 * 60; // 1800

/** Maximum consecutive failures before permanent max backoff */
const MAX_CONSECUTIVE_FAILURES = 10;

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
interface FeedHints {
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
  /**
   * Whether WebSub is active for this feed.
   * When true, uses a longer backup polling interval since WebSub
   * provides real-time push notifications.
   */
  websubActive?: boolean;
  /** The reference time to calculate from (defaults to now) */
  now?: Date;
  /**
   * Random number source for jitter (returns 0-1, like Math.random).
   * Defaults to Math.random. Pass a fixed value for deterministic tests.
   */
  randomSource?: () => number;
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
  | "websub_backup" // WebSub is active, using 24h minimum or default
  | "default" // No hints available, using default
  | "failure_backoff"; // Exponential backoff due to failures

/**
 * Calculates the next fetch time for a feed based on various hints.
 *
 * Priority order:
 * 1. If there are consecutive failures, use exponential backoff
 * 2. Determine base interval from hints:
 *    a. Cache-Control max-age from HTTP response
 *    b. RSS <ttl> element
 *    c. Syndication namespace hints
 *    d. WebSub backup default (24h) if WebSub active, else normal default (60min)
 * 3. Clamp to bounds based on context
 *
 * Bounds:
 * - WebSub active: min 24 hours (backup polling since we get real-time push)
 * - Cache hint present: min 10 minutes (trust server-provided hints)
 * - Otherwise: min 60 minutes (configurable via FEED_MIN_FETCH_INTERVAL_MINUTES)
 * - Maximum: 7 days (always check eventually)
 * - Failures capped at 10 (then max backoff)
 *
 * @param options - Calculation options
 * @returns The next fetch result with time and reason
 *
 * @example
 * // With WebSub active and cache headers (respects longer cache hint)
 * calculateNextFetch({
 *   websubActive: true,
 *   cacheControl: { maxAge: 172800, ... }, // 48 hours
 * })
 * // => { nextFetchAt: Date, intervalSeconds: 172800, reason: "cache_control" }
 *
 * @example
 * // With WebSub active and short cache headers (clamps to 24h minimum)
 * calculateNextFetch({
 *   websubActive: true,
 *   cacheControl: { maxAge: 3600, ... }, // 1 hour
 * })
 * // => { nextFetchAt: Date, intervalSeconds: 86400, reason: "websub_backup" }
 *
 * @example
 * // With WebSub active, no hints (uses 24h default)
 * calculateNextFetch({
 *   websubActive: true,
 * })
 * // => { nextFetchAt: Date, intervalSeconds: 86400, reason: "websub_backup" }
 *
 * @example
 * // With cache headers (no WebSub)
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
 * // No hints (default)
 * calculateNextFetch({})
 * // => { nextFetchAt: Date, intervalSeconds: 3600, reason: "default" }
 */
export function calculateNextFetch(options: CalculateNextFetchOptions = {}): NextFetchResult {
  const {
    cacheControl,
    feedHints,
    consecutiveFailures = 0,
    websubActive = false,
    now = new Date(),
    randomSource = Math.random,
  } = options;

  let intervalSeconds: number;
  let reason: NextFetchReason;

  // 1. If there are failures, use exponential backoff
  if (consecutiveFailures > 0) {
    intervalSeconds = calculateFailureBackoff(consecutiveFailures);
    reason = "failure_backoff";
  } else {
    // 2. Determine base interval from hints (in priority order)
    let baseInterval: number | undefined;
    let baseReason: NextFetchReason = "default";

    // 2a. Try Cache-Control max-age
    const effectiveMaxAge = cacheControl ? getEffectiveMaxAge(cacheControl) : undefined;
    if (effectiveMaxAge !== undefined) {
      baseInterval = effectiveMaxAge;
      baseReason = "cache_control";
    }
    // 2b. Try RSS <ttl> element (value is in minutes)
    else if (feedHints?.ttlMinutes !== undefined && feedHints.ttlMinutes > 0) {
      baseInterval = feedHints.ttlMinutes * 60;
      baseReason = "ttl";
    }
    // 2c. Try syndication namespace hints
    else {
      const syndicationSeconds = syndicationToSeconds(feedHints?.syndication);
      if (syndicationSeconds !== undefined) {
        baseInterval = syndicationSeconds;
        baseReason = "syndication";
      }
    }

    // 2d. Use default (WebSub backup if active, otherwise normal default)
    if (baseInterval === undefined) {
      if (websubActive) {
        baseInterval = WEBSUB_BACKUP_POLL_INTERVAL_SECONDS;
        baseReason = "websub_backup";
      } else {
        baseInterval = DEFAULT_FETCH_INTERVAL_SECONDS;
        baseReason = "default";
      }
    }

    // 3. Clamp to bounds
    // - WebSub active: min 24h (backup polling since we get real-time push)
    // - Cache hint present: min 10min (trust server-provided hints)
    // - Otherwise: min 60min (configurable default)
    const minInterval = websubActive
      ? WEBSUB_BACKUP_POLL_INTERVAL_SECONDS
      : effectiveMaxAge !== undefined
        ? MIN_FETCH_INTERVAL_WITH_CACHE_HINT_SECONDS
        : getMinFetchIntervalSeconds();

    if (baseInterval < minInterval) {
      intervalSeconds = minInterval;
      // Use "websub_backup" when WebSub minimum is applied
      reason = websubActive ? "websub_backup" : (`${baseReason}_clamped_min` as NextFetchReason);
    } else if (baseInterval > MAX_FETCH_INTERVAL_SECONDS) {
      intervalSeconds = MAX_FETCH_INTERVAL_SECONDS;
      reason = `${baseReason}_clamped_max` as NextFetchReason;
    } else {
      intervalSeconds = baseInterval;
      reason = baseReason;
    }
  }

  // Apply jitter to spread out fetches and prevent thundering herd
  const jitterSeconds = calculateJitter(intervalSeconds, randomSource());
  const totalSeconds = intervalSeconds + jitterSeconds;

  return {
    nextFetchAt: addSeconds(now, totalSeconds),
    intervalSeconds: totalSeconds,
    reason,
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
 * Calculates jitter to add to a fetch interval.
 *
 * Jitter is used to spread out feed fetches over time, preventing
 * thundering herd problems when many feeds are added at once.
 *
 * The jitter is calculated as a fraction of the interval (default 10%),
 * but capped at a maximum value (default 30 minutes) to ensure
 * long-interval feeds aren't delayed too much.
 *
 * @param intervalSeconds - The base interval in seconds
 * @param randomValue - A random value between 0 and 1
 * @returns Jitter in seconds to add to the interval
 *
 * @example
 * // 60 min interval with random=0.5 → 3 min jitter (50% of 10% of 60)
 * calculateJitter(3600, 0.5) // 180
 *
 * @example
 * // 7 day interval with random=1.0 → 30 min jitter (capped)
 * calculateJitter(604800, 1.0) // 1800
 */
export function calculateJitter(intervalSeconds: number, randomValue: number): number {
  // Max jitter is 10% of interval, but never more than 30 minutes
  const maxJitterForInterval = Math.min(
    intervalSeconds * DEFAULT_JITTER_FRACTION,
    MAX_JITTER_SECONDS
  );
  return Math.floor(maxJitterForInterval * randomValue);
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
