/**
 * Feed parsing module.
 * Exports types and parsers for RSS, Atom, and JSON Feed formats.
 * Uses streaming SAX parsers internally for memory efficiency.
 */

export type { ParsedFeed, ParsedEntry, SyndicationHints } from "./types";
export { getDomainFromUrl } from "./types";
export {
  parseFeed,
  parseFeedWithFormat,
  detectFeedType,
  UnknownFeedFormatError,
  type FeedType,
} from "./parser";
// Re-export streaming parsers for direct stream access
export {
  parseFeedStream,
  parseFeedStreamWithFormat,
  parseRssStream,
  parseAtomStream,
  parseJsonStream,
  parseOpmlStream,
  type StreamingFeedResult,
  type StreamingOpmlResult,
} from "./streaming";
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
  getNextFetchTime,
  syndicationToSeconds,
  getMinFetchIntervalSeconds,
  DEFAULT_MIN_FETCH_INTERVAL_SECONDS,
  MAX_FETCH_INTERVAL_SECONDS,
  DEFAULT_FETCH_INTERVAL_SECONDS,
  MAX_CONSECUTIVE_FAILURES,
  type CalculateNextFetchOptions,
  type FeedHints,
  type NextFetchResult,
  type NextFetchReason,
} from "./scheduling";
export {
  generateContentHash,
  deriveGuid,
  generateEntrySummary,
  cleanEntryContent,
  findEntryByGuid,
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
