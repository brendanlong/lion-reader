/**
 * Unified feed parser that auto-detects format (RSS, Atom, or JSON Feed).
 */

import type { FeedParseResult } from "./types";
import { parseRss, parseRssAsync } from "./rss-parser";
import { parseAtom, parseAtomAsync } from "./atom-parser";
import { parseJson } from "./json-parser";

export type FeedType = "rss" | "atom" | "json" | "unknown";

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
 * Parses a feed from a string, auto-detecting the format.
 */
export function parseFeed(content: string): FeedParseResult {
  const format = detectFeedType(content);

  switch (format) {
    case "rss":
      return parseRss(content);
    case "atom":
      return parseAtom(content);
    case "json":
      return parseJson(content);
    case "unknown":
      throw new UnknownFeedFormatError();
  }
}

/**
 * Async form of `parseFeed`: RSS/Atom parsing runs on the libuv thread pool
 * (via the native parser) so large feeds never block the event loop. JSON
 * Feed stays synchronous — `JSON.parse` is already native-fast.
 */
export async function parseFeedAsync(content: string): Promise<FeedParseResult> {
  const format = detectFeedType(content);

  switch (format) {
    case "rss":
      return parseRssAsync(content);
    case "atom":
      return parseAtomAsync(content);
    case "json":
      return parseJson(content);
    case "unknown":
      throw new UnknownFeedFormatError();
  }
}

/**
 * Parses a feed from a string with explicit format.
 */
export function parseFeedWithFormat(
  content: string,
  format: "rss" | "atom" | "json"
): FeedParseResult {
  switch (format) {
    case "rss":
      return parseRss(content);
    case "atom":
      return parseAtom(content);
    case "json":
      return parseJson(content);
  }
}
