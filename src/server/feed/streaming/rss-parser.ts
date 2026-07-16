/**
 * RSS 2.0 / RSS 1.0 (RDF) feed parser.
 *
 * The SAX state machine is the native `@lion-reader/feed-parser` module
 * (`native/feed-parser/core/src/rss.rs`, a direct port of the old
 * htmlparser2 parser that used to live here). Date parsing stays in this
 * file: the native side returns raw date strings and `toFeedParseResult`
 * replays the original pubDate/dc:date selection with `parseRssDate`, so the
 * V8-`new Date()`-based semantics are preserved exactly.
 */

import {
  parseRss as nativeParseRss,
  parseRssAsync as nativeParseRssAsync,
} from "@lion-reader/feed-parser";
import type { FeedParseResult } from "./types";
import { PARSE_INLINE_MAX_CHARS, toFeedParseResult } from "./native-result";

/**
 * Parses an RSS feed from a string.
 *
 * @param content - The RSS XML content as a string
 * @returns Parsed feed metadata and entries
 */
export function parseRss(content: string): FeedParseResult {
  return toFeedParseResult(nativeParseRss(content), parseRssDate);
}

/**
 * Async form of `parseRss`: the native parser runs on the libuv thread pool,
 * so a large feed never blocks the event loop. Small inputs run
 * synchronously (the async hop costs more than the parse).
 */
export async function parseRssAsync(content: string): Promise<FeedParseResult> {
  if (content.length <= PARSE_INLINE_MAX_CHARS) {
    return parseRss(content);
  }
  return toFeedParseResult(await nativeParseRssAsync(content), parseRssDate);
}

function parseRssDate(dateString: string): Date | undefined {
  const trimmed = dateString.trim();
  if (!trimmed) return undefined;

  const nativeDate = new Date(trimmed);
  if (!isNaN(nativeDate.getTime())) return nativeDate;

  const ddMonYyyy = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/;
  const match = trimmed.match(ddMonYyyy);
  if (match) {
    const parsed = new Date(
      `${match[2]} ${match[1]}, ${match[3]} ${match[4]}:${match[5]}:${match[6]} GMT`
    );
    if (!isNaN(parsed.getTime())) return parsed;
  }

  // Map named timezones to numeric offsets. V8's Date parser only understands a
  // handful of North American abbreviations, so European (and other) zones fall
  // through to here. Ambiguous abbreviations (IST, BST outside the UK, ...) are
  // deliberately omitted rather than guessed wrong.
  const timezoneMap: Record<string, string> = {
    UT: "+0000",
    GMT: "+0000",
    UTC: "+0000",
    Z: "+0000",
    EST: "-0500",
    EDT: "-0400",
    CST: "-0600",
    CDT: "-0500",
    MST: "-0700",
    MDT: "-0600",
    PST: "-0800",
    PDT: "-0700",
    WET: "+0000",
    WEST: "+0100",
    CET: "+0100",
    CEST: "+0200",
    EET: "+0200",
    EEST: "+0300",
  };

  // The timezone is the trailing alphabetic token of an RFC 822 date. Match it
  // anchored to the end of the string so a substring collision (e.g. "CEST"
  // containing "EST") can't corrupt the date. A numeric offset ("+0000") is
  // already handled by the native parse above and won't reach here.
  const tzMatch = trimmed.match(/\b([A-Za-z]{1,5})\s*$/);
  if (tzMatch && tzMatch.index !== undefined) {
    const offset = timezoneMap[tzMatch[1].toUpperCase()];
    if (offset) {
      const normalized = `${trimmed.slice(0, tzMatch.index).trimEnd()} ${offset}`;
      const parsed = new Date(normalized);
      if (!isNaN(parsed.getTime())) return parsed;
    }
  }

  return undefined;
}
