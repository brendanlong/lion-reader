/**
 * Streaming feed and OPML parsers.
 * These parsers work with ReadableStream<Uint8Array> and yield entries/feeds
 * via async generators as they're parsed.
 */

// Types
export type { StreamingFeedResult, StreamingOpmlResult, OpmlFeed } from "./types";

// Unified parser with auto-detection
export {
  parseFeedStream,
  parseFeedStreamWithFormat,
  detectFeedType,
  UnknownFeedFormatError,
} from "./parser";
export type { FeedType } from "./parser";

// Individual parsers
export { parseRssStream } from "./rss-parser";
export { parseAtomStream } from "./atom-parser";
export { parseJsonStream } from "./json-parser";
export { parseOpmlStream, OpmlStreamParseError } from "./opml-parser";
