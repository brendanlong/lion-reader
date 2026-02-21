/**
 * Unified feed parser that auto-detects format (RSS, Atom, or JSON Feed).
 * Provides a single entry point for parsing any supported feed format.
 *
 * Uses SAX-style parsing for memory efficiency.
 */

import type { ParsedFeed } from "./types";
import type { FeedParseResult } from "./streaming/types";
import {
  parseFeed as parseFeedInternal,
  parseFeedWithFormat as parseFeedWithFormatInternal,
  detectFeedType as detectFeedTypeInternal,
  UnknownFeedFormatError,
} from "./streaming/parser";
import { usageLimitsConfig } from "../config/env";

// Re-export for backwards compatibility
export { UnknownFeedFormatError };
/**
 * Converts a FeedParseResult to a ParsedFeed, applying the entry count limit.
 * Entries beyond the limit are silently dropped (we keep the most recent ones,
 * which are typically at the top of the feed).
 */
function resultToParsedFeed(result: FeedParseResult, maxEntries?: number): ParsedFeed {
  const limit = maxEntries ?? usageLimitsConfig.maxFeedEntries;
  return {
    title: result.title,
    description: result.description,
    siteUrl: result.siteUrl,
    iconUrl: result.iconUrl,
    hubUrl: result.hubUrl,
    selfUrl: result.selfUrl,
    ttlMinutes: result.ttlMinutes,
    syndication: result.syndication,
    items: result.entries.slice(0, limit),
  };
}

/**
 * Detects the feed type from content.
 * Uses simple heuristics to identify RSS, Atom, or JSON Feed formats.
 *
 * @param content - The feed content as a string
 * @returns The detected feed type
 */
export function detectFeedType(content: string): "rss" | "atom" | "json" | "unknown" {
  return detectFeedTypeInternal(content);
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
  const result = parseFeedInternal(content);
  return resultToParsedFeed(result);
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
  const result = parseFeedWithFormatInternal(content, format);
  return resultToParsedFeed(result);
}
