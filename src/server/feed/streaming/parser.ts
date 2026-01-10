/**
 * Unified streaming feed parser that auto-detects format (RSS, Atom, or JSON Feed).
 */

import type { StreamingFeedResult } from "./types";
import { parseRssStream } from "./rss-parser";
import { parseAtomStream } from "./atom-parser";
import { parseJsonStream } from "./json-parser";

export type FeedType = "rss" | "atom" | "json" | "unknown";

export class UnknownFeedFormatError extends Error {
  constructor(message = "Unknown feed format: unable to detect RSS, Atom, or JSON Feed") {
    super(message);
    this.name = "UnknownFeedFormatError";
  }
}

/**
 * Detects the feed type from the initial bytes of content.
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
 * Peeks at stream to detect format, returns format and reconstructed stream.
 */
async function peekAndDetectFormat(
  stream: ReadableStream<Uint8Array>
): Promise<{ format: FeedType; stream: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  let detectedFormat: FeedType = "unknown";
  let accumulatedText = "";
  const PEEK_SIZE = 2048;

  try {
    while (accumulatedText.length < PEEK_SIZE) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      accumulatedText += decoder.decode(value, { stream: true });

      detectedFormat = detectFeedType(accumulatedText);
      if (detectedFormat !== "unknown") break;
    }

    // Read remaining content
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

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
 */
export async function parseFeedStream(
  stream: ReadableStream<Uint8Array>
): Promise<StreamingFeedResult> {
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
 */
export async function parseFeedStreamWithFormat(
  stream: ReadableStream<Uint8Array>,
  format: "rss" | "atom" | "json"
): Promise<StreamingFeedResult> {
  switch (format) {
    case "rss":
      return parseRssStream(stream);
    case "atom":
      return parseAtomStream(stream);
    case "json":
      return parseJsonStream(stream);
  }
}
