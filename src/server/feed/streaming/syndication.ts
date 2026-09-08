/**
 * Syndication constants for feed parsing.
 *
 * @module feed/streaming/syndication
 */

/**
 * Valid values for sy:updatePeriod in RSS/Atom feeds.
 * Part of the RSS 1.0 Syndication Module specification.
 *
 * @see http://web.resource.org/rss/1.0/modules/syndication/
 */
export type UpdatePeriod = "hourly" | "daily" | "weekly" | "monthly" | "yearly";
