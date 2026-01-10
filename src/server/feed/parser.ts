/**
 * Unified feed parser that auto-detects format (RSS, Atom, or JSON Feed).
 * Provides a single entry point for parsing any supported feed format.
 *
 * Internally uses streaming SAX parsers for memory efficiency.
 */

import type { ParsedFeed, ParsedEntry } from "./types";
import type { StreamingFeedResult } from "./streaming/types";
import {
  parseFeedStream,
  parseFeedStreamWithFormat,
  detectFeedType as detectFeedTypeFromStream,
  UnknownFeedFormatError,
} from "./streaming/parser";

// Re-export for backwards compatibility
export { UnknownFeedFormatError };
export type { FeedType } from "./streaming/parser";

/**
 * Converts a string to a ReadableStream of Uint8Array.
 */
function stringToStream(content: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(content);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

/**
 * Collects all entries from an async generator into an array.
 */
async function collectEntries(
  generator: AsyncGenerator<ParsedEntry, void, undefined>
): Promise<ParsedEntry[]> {
  const entries: ParsedEntry[] = [];
  for await (const entry of generator) {
    entries.push(entry);
  }
  return entries;
}

/**
 * Converts a StreamingFeedResult to a ParsedFeed by collecting all entries.
 */
async function streamingResultToParsedFeed(result: StreamingFeedResult): Promise<ParsedFeed> {
  const items = await collectEntries(result.entries);
  return {
    title: result.title,
    description: result.description,
    siteUrl: result.siteUrl,
    iconUrl: result.iconUrl,
    hubUrl: result.hubUrl,
    selfUrl: result.selfUrl,
    ttlMinutes: result.ttlMinutes,
    syndication: result.syndication,
    items,
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
  return detectFeedTypeFromStream(content);
}

/**
 * Parses a feed string, auto-detecting the format (RSS, Atom, or JSON Feed).
 *
 * @param content - The feed content as a string
 * @returns A ParsedFeed object with normalized feed data
 * @throws UnknownFeedFormatError if the feed format cannot be detected
 * @throws Error if the feed is invalid (missing required elements)
 */
export async function parseFeed(content: string): Promise<ParsedFeed> {
  const stream = stringToStream(content);
  const result = await parseFeedStream(stream);
  return streamingResultToParsedFeed(result);
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
export async function parseFeedWithFormat(
  content: string,
  format: "rss" | "atom" | "json"
): Promise<ParsedFeed> {
  const stream = stringToStream(content);
  const result = await parseFeedStreamWithFormat(stream, format);
  return streamingResultToParsedFeed(result);
}
