/**
 * Feed parsing module.
 * Exports types and parsers for RSS, Atom, and JSON Feed formats.
 */

export type { ParsedFeed, ParsedEntry, SyndicationHints } from "./types";
export { getDomainFromUrl } from "./types";
export { parseRssFeed, parseRssDate } from "./rss-parser";
export { parseAtomFeed } from "./atom-parser";
export {
  parseFeed,
  parseFeedWithFormat,
  detectFeedType,
  UnknownFeedFormatError,
  type FeedType,
} from "./parser";
export {
  discoverFeeds,
  getCommonFeedUrls,
  COMMON_FEED_PATHS,
  type DiscoveredFeed,
} from "./discovery";
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
  calculateMinPostGap,
  calculateAdaptiveInterval,
  getNextFetchTime,
  syndicationToSeconds,
  getMinFetchIntervalSeconds,
  DEFAULT_MIN_FETCH_INTERVAL_SECONDS,
  MAX_FETCH_INTERVAL_SECONDS,
  DEFAULT_FETCH_INTERVAL_SECONDS,
  MAX_CONSECUTIVE_FAILURES,
  ADAPTIVE_LOOKBACK_SECONDS,
  MAX_ADAPTIVE_INTERVAL_SECONDS,
  type CalculateNextFetchOptions,
  type FeedHints,
  type NextFetchResult,
  type NextFetchReason,
} from "./scheduling";
export {
  generateContentHash,
  deriveGuid,
  generateSummary,
  cleanEntryContent,
  findEntryByGuid,
  getRecentEntryPublishDates,
  createEntry,
  updateEntryContent,
  processEntry,
  processEntries,
  createUserEntriesForFeed,
  type ProcessedEntry,
  type ProcessEntriesResult,
  type ProcessEntriesOptions,
} from "./entry-processor";
export {
  cleanContent,
  generateCleanedSummary,
  type CleanedContent,
  type CleanContentOptions,
} from "./content-cleaner";
export {
  canUseWebSub,
  getWebsubCallbackBaseUrl,
  generateCallbackUrl,
  generateCallbackSecret,
  subscribeToHub,
  handleVerificationChallenge,
  verifyHmacSignature,
  getActiveSubscription,
  unsubscribeFromHub,
  renewExpiringSubscriptions,
  type SubscribeToHubResult,
  type VerificationResult,
  type RenewSubscriptionsResult,
} from "./websub";
