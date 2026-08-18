/**
 * Unified feed parser that auto-detects format (RSS, Atom, or JSON Feed).
 * Provides a single entry point for parsing any supported feed format.
 *
 * Uses SAX-style parsing for memory efficiency.
 */

import type { ParsedEntry, ParsedFeed } from "./types";
import type { FeedParseResult } from "./streaming/types";
import {
  parseFeed as parseFeedInternal,
  parseFeedAsync as parseFeedAsyncInternal,
  parseFeedWithFormat as parseFeedWithFormatInternal,
  detectFeedType as detectFeedTypeInternal,
  UnknownFeedFormatError,
} from "./streaming/parser";
import { usageLimitsConfig } from "../config/env";
import { startFeedParseTimer } from "../metrics/metrics";

// Re-export for backwards compatibility
export { UnknownFeedFormatError };
/**
 * Picks which entries survive the `MAX_FEED_ENTRIES` limit.
 *
 * Rank by publication date, newest first, and keep the winners in the
 * publisher's original document order so downstream code still sees the feed's
 * ordering. Ties (identical dates) break on document position.
 *
 * We used to just take the first N, assuming newest-first document order. Plenty
 * of feeds aren't: WordPress serves an ascending feed for `?order=ASC`, and
 * generators emit oldest-first often enough to matter. For those, taking the
 * first N kept the archive and dropped everything recent — an over-long fetch
 * would import a pile of old articles and hide the new ones (issue #1500).
 *
 * Entries with no (or an unparseable) date can't be ranked, so a feed with any
 * such entry falls back to document order — the same assumption as before, but
 * now only where there is nothing better to go on.
 *
 * @param entries - All entries the parser found, in document order
 * @param limit - Maximum number of entries to keep
 * @returns At most `limit` entries, in document order
 */
export function selectEntriesWithinLimit(entries: ParsedEntry[], limit: number): ParsedEntry[] {
  if (entries.length <= limit) {
    return entries;
  }

  const ranked: Array<{ entry: ParsedEntry; index: number; time: number }> = [];
  for (const [index, entry] of entries.entries()) {
    const time = entry.pubDate?.getTime();
    if (time === undefined || Number.isNaN(time)) {
      return entries.slice(0, limit);
    }
    ranked.push({ entry, index, time });
  }

  return ranked
    .sort((a, b) => b.time - a.time || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((ranked) => ranked.entry);
}

/**
 * Converts a FeedParseResult to a ParsedFeed, applying the entry count limit.
 * Entries beyond the limit are dropped (see `selectEntriesWithinLimit`);
 * `totalItemCount` records how many there were so callers with feed context can
 * report the truncation.
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
    items: selectEntriesWithinLimit(result.entries, limit),
    totalItemCount: result.entries.length,
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
  const stopTimer = startFeedParseTimer();
  try {
    const result = parseFeedInternal(content);
    return resultToParsedFeed(result);
  } finally {
    stopTimer();
  }
}

/**
 * Async form of `parseFeed` for app-server request paths: RSS/Atom parsing
 * runs on the libuv thread pool (via the native `@lion-reader/feed-parser`
 * module), so a large feed never blocks the event loop that serves UI
 * requests; small feeds parse inline (the async hop costs more than the
 * parse). Background jobs (the feed poller) deliberately use the synchronous
 * `parseFeed` — they already run off the request path, so the async hop
 * would be pure overhead.
 *
 * @param content - The feed content as a string
 * @returns A ParsedFeed object with normalized feed data
 * @throws UnknownFeedFormatError if the feed format cannot be detected
 * @throws Error if the feed is invalid (missing required elements)
 */
export async function parseFeedAsync(content: string): Promise<ParsedFeed> {
  const stopTimer = startFeedParseTimer();
  try {
    const result = await parseFeedAsyncInternal(content);
    return resultToParsedFeed(result);
  } finally {
    stopTimer();
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
  const stopTimer = startFeedParseTimer();
  try {
    const result = parseFeedWithFormatInternal(content, format);
    return resultToParsedFeed(result);
  } finally {
    stopTimer();
  }
}
