/**
 * Feed parser result types.
 */

import type { ParsedEntry, SyndicationHints } from "../types";

/**
 * Result of feed parsing.
 * Contains feed metadata and parsed entries.
 */
export interface FeedParseResult {
  title?: string;
  description?: string;
  siteUrl?: string;
  iconUrl?: string;
  hubUrl?: string;
  selfUrl?: string;
  ttlMinutes?: number;
  syndication?: SyndicationHints;
  entries: ParsedEntry[];
}

/**
 * Result of OPML parsing.
 * Contains the list of feeds parsed from the OPML file.
 */
export interface OpmlParseResult {
  feeds: OpmlFeed[];
}

/**
 * A feed entry from an OPML file.
 */
export interface OpmlFeed {
  xmlUrl: string;
  title?: string;
  htmlUrl?: string;
  category?: string[];
}
