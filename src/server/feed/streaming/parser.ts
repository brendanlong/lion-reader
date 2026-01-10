/**
 * Unified streaming feed parser that auto-detects format (RSS, Atom, or JSON Feed).
 * Provides a single entry point for parsing any supported feed format from a stream.
 */

import type { ParsedFeed } from "../types";
import { parseRssStream } from "./rss-parser";
import { parseAtomStream } from "./atom-parser";
import { parseJsonStream } from "./json-parser";

/**
 * Detected feed type.
 */
export type FeedType = "rss" | "atom" | "json" | "unknown";

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
 * Detects the feed type from the initial bytes of content.
 * Uses simple heuristics to identify RSS, Atom, or JSON Feed formats.
 *
 * @param content - The beginning of the feed content
 * @returns The detected feed type
 */
export function detectFeedType(content: string): FeedType {
  // Remove leading whitespace and BOM for detection
  const trimmed = content.trim().replace(/^\uFEFF/, "");

  // Check for JSON Feed first (starts with { and likely has version field)
  if (trimmed.startsWith("{")) {
    // Quick check for JSON Feed version marker
    if (trimmed.includes('"https://jsonfeed.org/version/')) {
      return "json";
    }
    // Might still be JSON Feed but we can't tell from the first chunk
    // Default to json if it starts with {
    return "json";
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
 * Creates a stream that peeks at the first chunk to detect format,
 * then returns both the format and a new stream with the full content.
 */
async function peekAndDetectFormat(
  stream: ReadableStream<Uint8Array>
): Promise<{ format: FeedType; stream: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let detectedFormat: FeedType = "unknown";
  let accumulatedText = "";

  // Read enough to detect the format (up to 2KB should be plenty)
  const PEEK_SIZE = 2048;

  try {
    while (accumulatedText.length < PEEK_SIZE) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      accumulatedText += decoder.decode(value, { stream: true });

      // Try to detect format from what we have
      detectedFormat = detectFeedType(accumulatedText);
      if (detectedFormat !== "unknown") {
        break;
      }
    }

    // If still unknown after peek, might need more content
    // Keep reading chunks but continue trying to detect
    if (detectedFormat === "unknown") {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);

        // For unknown format, we'll try to detect from full content
        accumulatedText += decoder.decode(value, { stream: true });
        detectedFormat = detectFeedType(accumulatedText);
        if (detectedFormat !== "unknown") {
          break;
        }
      }
    }

    // If we've read the entire stream while detecting, read the rest
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // Create a new stream from the accumulated chunks
  const newStream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  return { format: detectedFormat, stream: newStream };
}

/**
 * Parses a feed from a ReadableStream, auto-detecting the format.
 *
 * @param stream - The readable stream containing feed data
 * @returns A promise that resolves to a ParsedFeed
 * @throws UnknownFeedFormatError if the feed format cannot be detected
 */
export async function parseFeedStream(stream: ReadableStream<Uint8Array>): Promise<ParsedFeed> {
  const { format, stream: newStream } = await peekAndDetectFormat(stream);

  switch (format) {
    case "rss":
      return parseRssStream(newStream);
    case "atom":
      return parseAtomStream(newStream);
    case "json":
      return parseJsonStream(newStream);
    case "unknown":
      throw new UnknownFeedFormatError();
  }
}

/**
 * Parses a feed from a ReadableStream with explicit format.
 * Use this when you know the feed type ahead of time.
 *
 * @param stream - The readable stream containing feed data
 * @param format - The feed format ("rss", "atom", or "json")
 * @returns A promise that resolves to a ParsedFeed
 */
export async function parseFeedStreamWithFormat(
  stream: ReadableStream<Uint8Array>,
  format: "rss" | "atom" | "json"
): Promise<ParsedFeed> {
  switch (format) {
    case "rss":
      return parseRssStream(stream);
    case "atom":
      return parseAtomStream(stream);
    case "json":
      return parseJsonStream(stream);
  }
}
