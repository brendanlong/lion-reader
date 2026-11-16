/**
 * Feed parser result types.
 */

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
