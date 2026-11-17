/**
 * Atom 1.0 feed parser.
 *
 * The SAX state machine is the native `@lion-reader/feed-parser` module
 * (`native/feed-parser/core/src/atom.rs`). Date parsing stays in this file:
 * the native side returns raw date strings and `toParsedFeed` does the
 * published/updated selection with V8's lenient `new Date()`.
 */

import {
  parseAtom as nativeParseAtom,
  parseAtomAsync as nativeParseAtomAsync,
} from "@lion-reader/feed-parser";
import { usageLimitsConfig } from "../../config/env";
import type { ParsedFeed } from "../types";
import { toParsedFeed } from "./native-result";
import { NATIVE_INLINE_MAX_CHARS } from "../../native-inline";

/**
 * Parses an Atom feed from a string.
 *
 * @param content - The Atom XML content as a string
 * @returns Parsed feed metadata and entries
 */
export function parseAtom(content: string): ParsedFeed {
  return toParsedFeed(nativeParseAtom(content, usageLimitsConfig.maxFeedEntries), parseAtomDate);
}

/**
 * Async form of `parseAtom`: the native parser runs on the libuv thread
 * pool, so a large feed never blocks the event loop. Small inputs run
 * synchronously (the async hop costs more than the parse).
 */
export async function parseAtomAsync(content: string): Promise<ParsedFeed> {
  if (content.length <= NATIVE_INLINE_MAX_CHARS) {
    return parseAtom(content);
  }
  return toParsedFeed(
    await nativeParseAtomAsync(content, usageLimitsConfig.maxFeedEntries),
    parseAtomDate
  );
}

function parseAtomDate(dateString: string): Date | undefined {
  const date = new Date(dateString);
  return isNaN(date.getTime()) ? undefined : date;
}
