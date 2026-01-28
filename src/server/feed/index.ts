/**
 * Feed parsing module.
 * Exports types and parsers for RSS, Atom, and JSON Feed formats.
 * Uses streaming SAX parsers internally for memory efficiency.
 */

export type { ParsedEntry } from "./types";
export { getDomainFromUrl } from "./types";
export { parseFeed, detectFeedType } from "./parser";
// Re-export SAX-based parsers for direct access
export { discoverFeeds, getCommonFeedUrls, type DiscoveredFeed } from "./discovery";
export { type ParsedCacheHeaders } from "./cache-headers";
export { fetchFeed, type FetchFeedResult, type RedirectInfo } from "./fetcher";
export { calculateNextFetch, WEBSUB_BACKUP_POLL_INTERVAL_SECONDS } from "./scheduling";
export { deriveGuid, processEntries, createUserEntriesForFeed } from "./entry-processor";
export {
  type LessWrongView,
  type LessWrongFeedConfig,
  type LessWrongPost,
  buildLessWrongFeedUrl,
  parseLessWrongFeedUrl,
  isLessWrongFeedUrl as isLessWrongApiFeedUrl,
  getLessWrongFeedTitle,
  fetchLessWrongFeedPosts,
  fetchLessWrongTag,
  lessWrongPostToParsedEntry,
  lessWrongPostsToParsedFeed,
  LESSWRONG_FETCH_PAGE_SIZE,
  LESSWRONG_FETCH_INTERVAL_MS,
} from "./lesswrong-feed";
export {
  handleVerificationChallenge,
  verifyHmacSignature,
  renewExpiringSubscriptions,
  canUseWebSub,
  subscribeToHub,
  deactivateWebsub,
  type SubscribeToHubResult,
} from "./websub";
