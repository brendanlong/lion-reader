/**
 * JSON Feed 1.1 parser.
 * Parses JSON Feed format into a unified ParsedFeed format.
 *
 * JSON Feed spec: https://jsonfeed.org/version/1.1
 */

import type { ParsedFeed, ParsedEntry } from "./types";

/**
 * JSON Feed author structure.
 */
interface JsonFeedAuthor {
  name?: string;
  url?: string;
  avatar?: string;
}

/**
 * JSON Feed hub structure for WebSub.
 */
interface JsonFeedHub {
  type: string;
  url: string;
}

/**
 * JSON Feed attachment structure.
 */
interface JsonFeedAttachment {
  url: string;
  mime_type: string;
  title?: string;
  size_in_bytes?: number;
  duration_in_seconds?: number;
}

/**
 * JSON Feed item structure.
 */
interface JsonFeedItem {
  id: string;
  url?: string;
  external_url?: string;
  title?: string;
  content_html?: string;
  content_text?: string;
  summary?: string;
  image?: string;
  banner_image?: string;
  date_published?: string;
  date_modified?: string;
  authors?: JsonFeedAuthor[];
  author?: JsonFeedAuthor; // deprecated in 1.1, but we support it
  tags?: string[];
  language?: string;
  attachments?: JsonFeedAttachment[];
}

/**
 * JSON Feed structure.
 */
interface JsonFeed {
  version: string;
  title: string;
  home_page_url?: string;
  feed_url?: string;
  description?: string;
  user_comment?: string;
  next_url?: string;
  icon?: string;
  favicon?: string;
  authors?: JsonFeedAuthor[];
  author?: JsonFeedAuthor; // deprecated in 1.1, but we support it
  language?: string;
  expired?: boolean;
  hubs?: JsonFeedHub[];
  items: JsonFeedItem[];
}

/**
 * Checks if content looks like JSON Feed.
 * Used for format detection.
 *
 * @param content - The content to check (string or parsed object)
 * @returns true if the content appears to be a JSON Feed
 */
export function isJsonFeed(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return false;
    }
    const feed = parsed as Record<string, unknown>;
    // JSON Feed must have a version string starting with "https://jsonfeed.org/version/"
    return (
      typeof feed.version === "string" && feed.version.startsWith("https://jsonfeed.org/version/")
    );
  } catch {
    return false;
  }
}

/**
 * Parses an ISO 8601 date string.
 * Returns undefined if the date cannot be parsed.
 *
 * @param dateString - The date string to parse
 * @returns A Date object or undefined
 */
export function parseJsonFeedDate(dateString: string | undefined): Date | undefined {
  if (!dateString || typeof dateString !== "string") {
    return undefined;
  }

  const trimmed = dateString.trim();
  if (!trimmed) {
    return undefined;
  }

  // Try native Date parsing (handles ISO 8601)
  const nativeDate = new Date(trimmed);
  if (!isNaN(nativeDate.getTime())) {
    return nativeDate;
  }

  return undefined;
}

/**
 * Extracts the first author name from the authors array.
 *
 * @param item - The JSON Feed item
 * @returns The author name or undefined
 */
function extractAuthor(item: JsonFeedItem): string | undefined {
  // Prefer authors array (JSON Feed 1.1)
  if (item.authors && item.authors.length > 0) {
    const firstAuthor = item.authors[0];
    if (firstAuthor.name) {
      return firstAuthor.name;
    }
  }

  // Fall back to deprecated author object (JSON Feed 1.0)
  if (item.author?.name) {
    return item.author.name;
  }

  return undefined;
}

/**
 * Parses a JSON Feed item into a ParsedEntry.
 *
 * @param item - The JSON Feed item to parse
 * @returns A ParsedEntry object
 */
function parseJsonFeedItem(item: JsonFeedItem): ParsedEntry {
  // Prefer content_html over content_text for full content
  const content = item.content_html || item.content_text;

  // Use summary if available, otherwise fall back to content_text for plain text preview
  const summary = item.summary || item.content_text;

  // Prefer date_published, fall back to date_modified
  const pubDate = parseJsonFeedDate(item.date_published) || parseJsonFeedDate(item.date_modified);

  return {
    guid: item.id,
    link: item.url || item.external_url,
    title: item.title,
    author: extractAuthor(item),
    content,
    summary,
    pubDate,
  };
}

/**
 * Extracts WebSub hub URL from the hubs array.
 *
 * @param feed - The JSON Feed object
 * @returns The WebSub hub URL or undefined
 */
function extractHubUrl(feed: JsonFeed): string | undefined {
  if (!feed.hubs || feed.hubs.length === 0) {
    return undefined;
  }

  // Look for a WebSub hub
  for (const hub of feed.hubs) {
    if (hub.type === "websub" && hub.url) {
      return hub.url;
    }
  }

  // Fall back to first hub if no WebSub-specific one found
  return feed.hubs[0].url;
}

/**
 * Parses a JSON Feed string into a ParsedFeed.
 *
 * @param json - The JSON Feed content as a string
 * @returns A ParsedFeed object with normalized feed data
 * @throws Error if the JSON is not a valid JSON Feed
 */
export function parseJsonFeed(json: string): ParsedFeed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid JSON Feed: failed to parse JSON");
  }

  // JSON Feed must be an object (not array, null, or primitive)
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid JSON Feed: root must be an object");
  }

  const feed = parsed as JsonFeed;

  // Validate version
  if (
    typeof feed.version !== "string" ||
    !feed.version.startsWith("https://jsonfeed.org/version/")
  ) {
    throw new Error("Invalid JSON Feed: missing or invalid version");
  }

  // Validate items array
  if (!Array.isArray(feed.items)) {
    throw new Error("Invalid JSON Feed: missing items array");
  }

  // Prefer favicon over icon (favicon is smaller, like our iconUrl intent)
  const iconUrl = feed.favicon || feed.icon;

  // Extract title (may be undefined if feed has no title)
  const title = typeof feed.title === "string" ? feed.title.trim() || undefined : undefined;

  return {
    title,
    description: feed.description?.trim(),
    siteUrl: feed.home_page_url,
    iconUrl,
    items: feed.items.map(parseJsonFeedItem),
    hubUrl: extractHubUrl(feed),
    selfUrl: feed.feed_url,
  };
}
