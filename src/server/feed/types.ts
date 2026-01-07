/**
 * Unified feed parsing output interfaces.
 * These are used as the common output format for all feed parsers (RSS, Atom, JSON Feed).
 */

/**
 * Extracts the domain from a URL for use as a fallback feed title.
 * Returns just the hostname (e.g., "danluu.com" from "https://danluu.com/atom.xml").
 *
 * @param url - The feed URL
 * @returns The domain name, or undefined if the URL is invalid
 */
export function getDomainFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

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
 * Update interval hints from RSS Syndication namespace.
 * Used to calculate refresh intervals based on feed-provided hints.
 *
 * @see http://web.resource.org/rss/1.0/modules/syndication/
 */
export interface SyndicationHints {
  /**
   * Period for updates: "hourly", "daily", "weekly", "monthly", "yearly"
   * @example "daily" means the feed updates once per day
   */
  updatePeriod?: "hourly" | "daily" | "weekly" | "monthly" | "yearly";
  /**
   * Frequency of updates within the period.
   * @example updatePeriod="daily" + updateFrequency=2 means twice per day
   */
  updateFrequency?: number;
}

/**
 * A parsed feed from any format (RSS, Atom, JSON Feed).
 */
export interface ParsedFeed {
  /** Feed title (may be undefined if feed has no title) */
  title?: string;
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

  /**
   * RSS 2.0 <ttl> element: time-to-live in minutes.
   * Indicates how long a channel can be cached before refreshing.
   * @see https://www.rssboard.org/rss-specification#ltttlgtSubelementOfLtchannelgt
   */
  ttlMinutes?: number;

  /**
   * Syndication namespace hints for update frequency.
   * @see http://web.resource.org/rss/1.0/modules/syndication/
   */
  syndication?: SyndicationHints;
}
