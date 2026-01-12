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
export { calculateNextFetch } from "./scheduling";
export { deriveGuid, processEntries, createUserEntriesForFeed } from "./entry-processor";
export {
  handleVerificationChallenge,
  verifyHmacSignature,
  renewExpiringSubscriptions,
  canUseWebSub,
  subscribeToHub,
  deactivateWebsub,
  type SubscribeToHubResult,
} from "./websub";
