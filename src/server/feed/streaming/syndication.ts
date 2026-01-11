/**
 * Syndication constants shared between RSS and Atom parsers.
 *
 * @module feed/streaming/syndication
 */

/**
 * Valid values for sy:updatePeriod in RSS/Atom feeds.
 * Part of the RSS 1.0 Syndication Module specification.
 *
 * @see http://web.resource.org/rss/1.0/modules/syndication/
 */
export const VALID_UPDATE_PERIODS = ["hourly", "daily", "weekly", "monthly", "yearly"] as const;

/**
 * Type for valid update period values.
 */
export type UpdatePeriod = (typeof VALID_UPDATE_PERIODS)[number];
