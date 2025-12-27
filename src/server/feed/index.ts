/**
 * Feed parsing module.
 * Exports types and parsers for RSS, Atom, and JSON Feed formats.
 */

export type { ParsedFeed, ParsedEntry } from "./types";
export { parseRssFeed, parseRssDate } from "./rss-parser";
export { parseAtomFeed } from "./atom-parser";
export {
  parseFeed,
  parseFeedWithFormat,
  detectFeedType,
  UnknownFeedFormatError,
  type FeedType,
} from "./parser";
export { discoverFeeds, type DiscoveredFeed } from "./discovery";
export {
  parseCacheControl,
  parseCacheHeaders,
  getEffectiveMaxAge,
  type CacheControl,
  type ParsedCacheHeaders,
} from "./cache-headers";
export {
  fetchFeed,
  shouldRetry,
  getRetryDelay,
  type FetchFeedOptions,
  type FetchFeedResult,
  type FetchSuccessResult,
  type FetchNotModifiedResult,
  type FetchPermanentRedirectResult,
  type FetchClientErrorResult,
  type FetchServerErrorResult,
  type FetchRateLimitedResult,
  type FetchNetworkErrorResult,
  type FetchTooManyRedirectsResult,
  type RedirectInfo,
} from "./fetcher";
export {
  calculateNextFetch,
  calculateFailureBackoff,
  getNextFetchTime,
  MIN_FETCH_INTERVAL_SECONDS,
  MAX_FETCH_INTERVAL_SECONDS,
  DEFAULT_FETCH_INTERVAL_SECONDS,
  MAX_CONSECUTIVE_FAILURES,
  type CalculateNextFetchOptions,
  type NextFetchResult,
  type NextFetchReason,
} from "./scheduling";
export {
  generateContentHash,
  deriveGuid,
  generateSummary,
  findEntryByGuid,
  createEntry,
  updateEntryContent,
  processEntry,
  processEntries,
  type ProcessedEntry,
  type ProcessEntriesResult,
  type ProcessEntriesOptions,
} from "./entry-processor";
