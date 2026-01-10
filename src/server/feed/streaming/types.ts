/**
 * Streaming feed parser result types.
 */

import type { ParsedEntry, SyndicationHints } from "../types";

/**
 * Result of streaming feed parsing.
 * Metadata is available immediately; entries are yielded as they're parsed.
 */
export interface StreamingFeedResult {
  title?: string;
  description?: string;
  siteUrl?: string;
  iconUrl?: string;
  hubUrl?: string;
  selfUrl?: string;
  ttlMinutes?: number;
  syndication?: SyndicationHints;
  entries: AsyncGenerator<ParsedEntry, void, undefined>;
}

/**
 * Result of streaming OPML parsing.
 * Feeds are yielded as they're parsed from the OPML file.
 */
export interface StreamingOpmlResult {
  feeds: AsyncGenerator<OpmlFeed, void, undefined>;
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
