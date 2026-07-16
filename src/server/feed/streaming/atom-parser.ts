/**
 * Atom 1.0 feed parser.
 *
 * The SAX state machine is the native `@lion-reader/feed-parser` module
 * (`native/feed-parser/core/src/atom.rs`, a direct port of the old
 * htmlparser2 parser that used to live here). Date parsing stays in this
 * file: the native side returns raw date strings and `toFeedParseResult`
 * replays the original published/updated selection with V8's `new Date()`,
 * so date semantics are preserved exactly.
 */

import {
  parseAtom as nativeParseAtom,
  parseAtomAsync as nativeParseAtomAsync,
} from "@lion-reader/feed-parser";
import type { FeedParseResult } from "./types";
import { PARSE_INLINE_MAX_CHARS, toFeedParseResult } from "./native-result";

/**
 * Parses an Atom feed from a string.
 *
 * @param content - The Atom XML content as a string
 * @returns Parsed feed metadata and entries
 */
export function parseAtom(content: string): FeedParseResult {
  return toFeedParseResult(nativeParseAtom(content), parseAtomDate);
}

/**
 * Async form of `parseAtom`: the native parser runs on the libuv thread
 * pool, so a large feed never blocks the event loop. Small inputs run
 * synchronously (the async hop costs more than the parse).
 */
export async function parseAtomAsync(content: string): Promise<FeedParseResult> {
  if (content.length <= PARSE_INLINE_MAX_CHARS) {
    return parseAtom(content);
  }
  return toFeedParseResult(await nativeParseAtomAsync(content), parseAtomDate);
}

function parseAtomDate(dateString: string): Date | undefined {
  const date = new Date(dateString);
  return isNaN(date.getTime()) ? undefined : date;
}
