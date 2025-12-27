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
