/**
 * OPML parser.
 *
 * The SAX state machine is the native `@lion-reader/feed-parser` module
 * (`native/feed-parser/core/src/opml.rs`, a direct port of the old
 * htmlparser2 parser that used to live here). Structural validation and the
 * error type stay in TypeScript so the messages don't change.
 */

import {
  parseOpml as nativeParseOpml,
  parseOpmlAsync as nativeParseOpmlAsync,
} from "@lion-reader/feed-parser";
import type { RawOpmlResult } from "@lion-reader/feed-parser";
import type { OpmlParseResult } from "./types";
import { PARSE_INLINE_MAX_CHARS } from "./native-result";

/**
 * Error thrown when OPML parsing fails.
 */
export class OpmlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpmlParseError";
  }
}

function toOpmlParseResult(raw: RawOpmlResult): OpmlParseResult {
  if (!raw.hasOpml) {
    throw new OpmlParseError("Invalid OPML: missing opml element");
  }
  if (!raw.hasBody) {
    throw new OpmlParseError("Invalid OPML: missing body element");
  }
  return {
    feeds: raw.feeds.map((feed) => ({
      xmlUrl: feed.xmlUrl,
      title: feed.title,
      htmlUrl: feed.htmlUrl,
      category: feed.category,
    })),
  };
}

/** Wrap XML-level parse failures so callers always see an OpmlParseError. */
function toOpmlError(error: unknown): OpmlParseError {
  return error instanceof OpmlParseError
    ? error
    : new OpmlParseError(`Invalid OPML: ${error instanceof Error ? error.message : String(error)}`);
}

/**
 * Parses an OPML file from a string.
 *
 * @param content - The OPML XML content as a string
 * @returns Parsed OPML feeds
 * @throws OpmlParseError if the content is not valid OPML
 */
export function parseOpml(content: string): OpmlParseResult {
  try {
    return toOpmlParseResult(nativeParseOpml(content));
  } catch (error) {
    throw toOpmlError(error);
  }
}

/**
 * Async form of `parseOpml`: the native parser runs on the libuv thread
 * pool, so a large OPML file never blocks the event loop. Use from
 * app-server request paths (OPML import/preview). Small inputs run
 * synchronously (the async hop costs more than the parse).
 */
export async function parseOpmlAsync(content: string): Promise<OpmlParseResult> {
  if (content.length <= PARSE_INLINE_MAX_CHARS) {
    return parseOpml(content);
  }
  try {
    return toOpmlParseResult(await nativeParseOpmlAsync(content));
  } catch (error) {
    throw toOpmlError(error);
  }
}
