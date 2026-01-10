/**
 * Streaming feed and OPML parsers.
 * These parsers work with ReadableStream<Uint8Array> and don't require
 * loading the entire content into memory before parsing.
 */

// Unified parser with auto-detection
export {
  parseFeedStream,
  parseFeedStreamWithFormat,
  detectFeedType,
  UnknownFeedFormatError,
  type FeedType,
} from "./parser";

// Individual parsers
export { parseRssStream } from "./rss-parser";
export { parseAtomStream } from "./atom-parser";
export { parseJsonStream, parseJsonStreamWithCallback } from "./json-parser";
export { parseOpmlStream, parseOpmlStreamWithCallback, OpmlStreamParseError } from "./opml-parser";
