/**
 * Unified feed parser that auto-detects format (RSS, Atom, or JSON Feed).
 * Provides a single entry point for parsing any supported feed format.
 */

import type { ParsedFeed } from "./types";
import { parseRssFeed } from "./rss-parser";
import { parseAtomFeed } from "./atom-parser";
import { parseJsonFeed, isJsonFeed } from "./json-parser";

/**
 * Detected feed type.
 */
export type FeedType = "rss" | "atom" | "json" | "unknown";

/**
 * Detects the feed type from content.
 * Uses simple heuristics to identify RSS, Atom, or JSON Feed formats.
 *
 * @param content - The feed content as a string
 * @returns The detected feed type
 */
export function detectFeedType(content: string): FeedType {
  // Remove leading whitespace for detection
  const trimmed = content.trim();

  // Check for JSON Feed first (starts with { and has version field)
  if (trimmed.startsWith("{")) {
    if (isJsonFeed(trimmed)) {
      return "json";
    }
    // Could be JSON but not a JSON Feed
    return "unknown";
  }

  // Look for Atom feed element
  // Atom feeds have <feed xmlns="http://www.w3.org/2005/Atom"> or <feed>
  if (/<feed[\s>]/i.test(trimmed) && !/<rss[\s>]/i.test(trimmed)) {
    return "atom";
  }

  // Look for RSS feed element
  // RSS 2.0 has <rss version="2.0">
  if (/<rss[\s>]/i.test(trimmed)) {
    return "rss";
  }

  // Look for RSS 1.0 (RDF-based)
  // RSS 1.0 has <rdf:RDF xmlns="http://purl.org/rss/1.0/">
  if (/<rdf:RDF[\s>]/i.test(trimmed)) {
    return "rss";
  }

  // Look for channel element (common in RSS)
  // If there's a <channel> without <feed>, it's likely RSS
  if (/<channel[\s>]/i.test(trimmed) && !/<feed[\s>]/i.test(trimmed)) {
    return "rss";
  }

  return "unknown";
}

/**
 * Error thrown when feed format cannot be detected.
 */
export class UnknownFeedFormatError extends Error {
  constructor(message = "Unknown feed format: unable to detect RSS, Atom, or JSON Feed") {
    super(message);
    this.name = "UnknownFeedFormatError";
  }
}

/**
 * Parses a feed string, auto-detecting the format (RSS, Atom, or JSON Feed).
 *
 * @param content - The feed content as a string
 * @returns A ParsedFeed object with normalized feed data
 * @throws UnknownFeedFormatError if the feed format cannot be detected
 * @throws Error if the feed is invalid (missing required elements)
 */
export function parseFeed(content: string): ParsedFeed {
  const feedType = detectFeedType(content);

  switch (feedType) {
    case "rss":
      return parseRssFeed(content);
    case "atom":
      return parseAtomFeed(content);
    case "json":
      return parseJsonFeed(content);
    case "unknown":
      throw new UnknownFeedFormatError();
  }
}

/**
 * Parses a feed string with explicit format.
 * Use this when you know the feed type ahead of time (e.g., from Content-Type header).
 *
 * @param content - The feed content as a string
 * @param format - The feed format ("rss", "atom", or "json")
 * @returns A ParsedFeed object with normalized feed data
 * @throws Error if the feed is invalid
 */
export function parseFeedWithFormat(content: string, format: "rss" | "atom" | "json"): ParsedFeed {
  switch (format) {
    case "rss":
      return parseRssFeed(content);
    case "atom":
      return parseAtomFeed(content);
    case "json":
      return parseJsonFeed(content);
  }
}
