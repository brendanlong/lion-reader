/**
 * Unified feed parser that auto-detects format (RSS, Atom, or JSON Feed).
 */

import type { ParsedFeed } from "./types";
import { parseRss, parseRssAsync } from "./streaming/rss-parser";
import { parseAtom, parseAtomAsync } from "./streaming/atom-parser";
import { parseJson } from "./streaming/json-parser";
import { startFeedParseTimer } from "../metrics/metrics";

type FeedType = "rss" | "atom" | "json" | "unknown";

export class UnknownFeedFormatError extends Error {
  constructor(message = "Unknown feed format: unable to detect RSS, Atom, or JSON Feed") {
    super(message);
    this.name = "UnknownFeedFormatError";
  }
}

/**
 * Detects the feed type from the content.
 */
export function detectFeedType(content: string): FeedType {
  const trimmed = content.trim().replace(/^\uFEFF/, "");

  if (trimmed.startsWith("{")) {
    return "json";
  }

  if (/<feed[\s>]/i.test(trimmed) && !/<rss[\s>]/i.test(trimmed)) {
    return "atom";
  }

  if (/<rss[\s>]/i.test(trimmed) || /<rdf:RDF[\s>]/i.test(trimmed)) {
    return "rss";
  }

  if (/<channel[\s>]/i.test(trimmed) && !/<feed[\s>]/i.test(trimmed)) {
    return "rss";
  }

  return "unknown";
}

/**
 * Parses a feed string, auto-detecting the format (RSS, Atom, or JSON Feed).
 *
 * @throws UnknownFeedFormatError if the feed format cannot be detected
 * @throws Error if the feed is invalid (missing required elements)
 */
export function parseFeed(content: string): ParsedFeed {
  const stopTimer = startFeedParseTimer();
  try {
    switch (detectFeedType(content)) {
      case "rss":
        return parseRss(content);
      case "atom":
        return parseAtom(content);
      case "json":
        return parseJson(content);
      case "unknown":
        throw new UnknownFeedFormatError();
    }
  } finally {
    stopTimer();
  }
}

/**
 * Async form of `parseFeed` for app-server request paths: RSS/Atom parsing
 * runs on the libuv thread pool (via the native `@lion-reader/feed-parser`
 * module), so a large feed never blocks the event loop that serves UI
 * requests; small feeds parse inline (the async hop costs more than the
 * parse). JSON Feed stays synchronous — `JSON.parse` is already native-fast.
 * Background jobs (the feed poller) deliberately use the synchronous
 * `parseFeed` — they already run off the request path, so the async hop
 * would be pure overhead.
 *
 * @throws UnknownFeedFormatError if the feed format cannot be detected
 * @throws Error if the feed is invalid (missing required elements)
 */
export async function parseFeedAsync(content: string): Promise<ParsedFeed> {
  const stopTimer = startFeedParseTimer();
  try {
    switch (detectFeedType(content)) {
      case "rss":
        return await parseRssAsync(content);
      case "atom":
        return await parseAtomAsync(content);
      case "json":
        return parseJson(content);
      case "unknown":
        throw new UnknownFeedFormatError();
    }
  } finally {
    stopTimer();
  }
}
