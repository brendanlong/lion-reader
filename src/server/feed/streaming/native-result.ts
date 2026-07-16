/**
 * Conversion from the native feed parser's raw output to `FeedParseResult`.
 *
 * The native module (`@lion-reader/feed-parser`) returns entry dates as raw
 * strings because it can't reproduce V8's lenient `new Date()` parsing; this
 * module replays the original selection logic with a caller-supplied JS date
 * parser, keeping date semantics byte-for-byte identical to the old
 * htmlparser2-based parsers.
 */

import type { DateCandidate, RawParsedFeed } from "@lion-reader/feed-parser";
import type { SyndicationHints } from "../types";
import type { UpdatePeriod } from "./syndication";
import type { FeedParseResult } from "./types";

/**
 * Inputs at or below this size are parsed synchronously by the `*Async`
 * parser entry points instead of scheduling a libuv-thread-pool task: the
 * native parser finishes in well under a millisecond for them, so the fixed
 * cost of the async hop isn't worth paying. ~10 KB, same rationale and value
 * as the sanitizer's and content cleaner's inline thresholds.
 */
export const PARSE_INLINE_MAX_CHARS = 10 * 1024;

/**
 * Replays the old parsers' date selection over the document-ordered raw
 * candidates: a primary element (RSS `pubDate`, Atom `published`) that parses
 * successfully overwrites the current date; a fallback element (RSS
 * `dc:date`, Atom `updated`) applies only while no date has been selected.
 */
function resolveDate(
  candidates: DateCandidate[],
  parseDate: (value: string) => Date | undefined
): Date | undefined {
  let date: Date | undefined;
  for (const candidate of candidates) {
    if (candidate.primary) {
      const parsed = parseDate(candidate.value);
      if (parsed) date = parsed;
    } else if (!date) {
      const parsed = parseDate(candidate.value);
      if (parsed) date = parsed;
    }
  }
  return date;
}

/** Converts the native parser's raw feed into a `FeedParseResult`. */
export function toFeedParseResult(
  raw: RawParsedFeed,
  parseDate: (value: string) => Date | undefined
): FeedParseResult {
  let syndication: SyndicationHints | undefined;
  if (raw.updatePeriod !== undefined || raw.updateFrequency !== undefined) {
    syndication = {};
    // The native side already lowercased and validated the period value.
    if (raw.updatePeriod) syndication.updatePeriod = raw.updatePeriod as UpdatePeriod;
    if (raw.updateFrequency) syndication.updateFrequency = raw.updateFrequency;
  }

  return {
    title: raw.title,
    description: raw.description,
    siteUrl: raw.siteUrl,
    iconUrl: raw.iconUrl,
    hubUrl: raw.hubUrl,
    selfUrl: raw.selfUrl,
    ttlMinutes: raw.ttlMinutes,
    syndication,
    entries: raw.entries.map((entry) => ({
      guid: entry.guid,
      link: entry.link,
      title: entry.title,
      author: entry.author,
      content: entry.content,
      summary: entry.summary,
      mediaDescription: entry.mediaDescription,
      mediaThumbnailUrl: entry.mediaThumbnailUrl,
      pubDate: resolveDate(entry.dateCandidates, parseDate),
    })),
  };
}
