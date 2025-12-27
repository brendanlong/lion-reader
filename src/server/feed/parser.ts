/**
 * Unified feed parser that auto-detects format (RSS or Atom).
 * Provides a single entry point for parsing any supported feed format.
 */

import type { ParsedFeed } from "./types";
import { parseRssFeed } from "./rss-parser";
import { parseAtomFeed } from "./atom-parser";

/**
 * Detected feed type.
 */
export type FeedType = "rss" | "atom" | "unknown";

/**
 * Detects the feed type from XML content.
 * Uses simple heuristics to identify RSS vs Atom feeds.
 *
 * @param xml - The feed XML content as a string
 * @returns The detected feed type
 */
export function detectFeedType(xml: string): FeedType {
  // Remove XML declaration and leading whitespace for detection
  const trimmed = xml.trim();

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
  constructor(message = "Unknown feed format: unable to detect RSS or Atom") {
    super(message);
    this.name = "UnknownFeedFormatError";
  }
}

/**
 * Parses a feed XML string, auto-detecting the format (RSS or Atom).
 *
 * @param xml - The feed XML content as a string
 * @returns A ParsedFeed object with normalized feed data
 * @throws UnknownFeedFormatError if the feed format cannot be detected
 * @throws Error if the feed is invalid (missing required elements)
 */
export function parseFeed(xml: string): ParsedFeed {
  const feedType = detectFeedType(xml);

  switch (feedType) {
    case "rss":
      return parseRssFeed(xml);
    case "atom":
      return parseAtomFeed(xml);
    case "unknown":
      throw new UnknownFeedFormatError();
  }
}

/**
 * Parses a feed XML string with explicit format.
 * Use this when you know the feed type ahead of time (e.g., from Content-Type header).
 *
 * @param xml - The feed XML content as a string
 * @param format - The feed format ("rss" or "atom")
 * @returns A ParsedFeed object with normalized feed data
 * @throws Error if the feed is invalid
 */
export function parseFeedWithFormat(xml: string, format: "rss" | "atom"): ParsedFeed {
  switch (format) {
    case "rss":
      return parseRssFeed(xml);
    case "atom":
      return parseAtomFeed(xml);
  }
}
