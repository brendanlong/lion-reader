/**
 * Feed and OPML parsers using SAX-style parsing.
 * These parsers work with strings and return parsed results synchronously.
 */

// Types
export type { FeedParseResult, OpmlParseResult, OpmlFeed } from "./types";

// Unified parser with auto-detection
export { parseFeed, parseFeedWithFormat, detectFeedType, UnknownFeedFormatError } from "./parser";
export type { FeedType } from "./parser";

// Individual parsers
export { parseRss } from "./rss-parser";
export { parseAtom } from "./atom-parser";
export { parseJson } from "./json-parser";
export { parseOpml, OpmlParseError } from "./opml-parser";
