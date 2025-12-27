/**
 * Unified feed parsing output interfaces.
 * These are used as the common output format for all feed parsers (RSS, Atom, JSON Feed).
 */

/**
 * A parsed entry from any feed format.
 */
export interface ParsedEntry {
  /** Unique identifier for the entry (guid in RSS, id in Atom) */
  guid?: string;
  /** URL link to the entry */
  link?: string;
  /** Entry title */
  title?: string;
  /** Author name */
  author?: string;
  /** Full content of the entry (content:encoded in RSS, content in Atom) */
  content?: string;
  /** Summary/description of the entry */
  summary?: string;
  /** Publication date of the entry */
  pubDate?: Date;
}

/**
 * A parsed feed from any format (RSS, Atom, JSON Feed).
 */
export interface ParsedFeed {
  /** Feed title */
  title: string;
  /** Feed description */
  description?: string;
  /** URL to the feed's website */
  siteUrl?: string;
  /** URL to the feed's icon/favicon */
  iconUrl?: string;
  /** Feed entries */
  items: ParsedEntry[];

  /** WebSub hub URL for push notifications */
  hubUrl?: string;
  /** Self link URL (canonical URL of the feed) */
  selfUrl?: string;
}
