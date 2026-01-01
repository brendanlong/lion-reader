/**
 * Feed discovery from HTML pages.
 * Parses HTML to find <link rel="alternate"> tags pointing to RSS/Atom/JSON feeds.
 */

import { JSDOM } from "jsdom";

/**
 * A discovered feed from an HTML page.
 */
export interface DiscoveredFeed {
  /** The URL of the feed (resolved to absolute) */
  url: string;
  /** The type of feed (rss, atom, json, or unknown) */
  type: "rss" | "atom" | "json" | "unknown";
  /** The title of the feed (from title attribute, if present) */
  title?: string;
}

/**
 * Known feed MIME types and their corresponding feed types.
 */
const FEED_MIME_TYPES: Record<string, DiscoveredFeed["type"]> = {
  "application/rss+xml": "rss",
  "application/atom+xml": "atom",
  "application/feed+json": "json",
  "application/json": "json",
  "application/xml": "unknown",
  "text/xml": "unknown",
};

/**
 * Common feed paths to check on websites.
 * These are checked in order of likelihood.
 */
export const COMMON_FEED_PATHS = [
  "/feed",
  "/feed.xml",
  "/rss",
  "/rss.xml",
  "/atom.xml",
  "/index.xml",
  "/feed.json",
  "/feed/",
  "/rss/",
  "/atom/",
  "/blog/feed",
  "/blog/rss",
  "/blog/feed.xml",
  "/blog/rss.xml",
  "/blog/atom.xml",
  "/.rss",
];

/**
 * Checks if a rel attribute value indicates an alternate link.
 * The rel attribute can contain multiple space-separated values.
 *
 * @param rel - The rel attribute value
 * @returns True if it contains "alternate"
 */
function isAlternateRel(rel: string | undefined): boolean {
  if (!rel) {
    return false;
  }
  const values = rel.toLowerCase().split(/\s+/);
  return values.includes("alternate");
}

/**
 * Determines the feed type from a MIME type string.
 *
 * @param mimeType - The MIME type (e.g., "application/rss+xml")
 * @returns The feed type, or null if not a recognized feed type
 */
function getFeedTypeFromMime(mimeType: string | undefined): DiscoveredFeed["type"] | null {
  if (!mimeType) {
    return null;
  }
  // Normalize: lowercase and extract main type (ignore charset etc.)
  const normalized = mimeType.toLowerCase().split(";")[0].trim();
  return FEED_MIME_TYPES[normalized] ?? null;
}

/**
 * Resolves a potentially relative URL against a base URL.
 *
 * @param href - The URL to resolve (can be relative or absolute)
 * @param baseUrl - The base URL to resolve against
 * @returns The absolute URL, or null if invalid
 */
function resolveUrl(href: string | undefined, baseUrl: string): string | null {
  if (!href) {
    return null;
  }

  try {
    // URL constructor handles both absolute and relative URLs
    const resolved = new URL(href, baseUrl);
    return resolved.href;
  } catch {
    // Invalid URL
    return null;
  }
}

/**
 * Discovers feeds from an HTML page by parsing <link rel="alternate"> tags.
 *
 * Looks for link tags with:
 * - rel="alternate" (or rel containing "alternate")
 * - type="application/rss+xml" or type="application/atom+xml"
 *
 * @param html - The HTML content to parse
 * @param baseUrl - The base URL for resolving relative URLs
 * @returns An array of discovered feeds (may be empty)
 *
 * @example
 * ```typescript
 * const feeds = discoverFeeds(html, "https://example.com/page");
 * // Returns: [{ url: "https://example.com/feed.xml", type: "rss", title: "Example Feed" }]
 * ```
 */
export function discoverFeeds(html: string, baseUrl: string): DiscoveredFeed[] {
  const feeds: DiscoveredFeed[] = [];
  const seenUrls = new Set<string>();

  // Parse HTML using JSDOM
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Find all link tags with rel="alternate"
  const linkElements = doc.querySelectorAll("link");

  for (const link of linkElements) {
    // Check if this is a rel="alternate" link
    const rel = link.getAttribute("rel") ?? undefined;
    if (!isAlternateRel(rel)) {
      continue;
    }

    // Check if the type is a feed type
    const type = link.getAttribute("type");
    const feedType = getFeedTypeFromMime(type ?? undefined);
    if (feedType === null) {
      continue;
    }

    // Extract and resolve the href
    const href = link.getAttribute("href");
    const resolvedUrl = resolveUrl(href ?? undefined, baseUrl);
    if (!resolvedUrl) {
      continue;
    }

    // Skip duplicates
    if (seenUrls.has(resolvedUrl)) {
      continue;
    }
    seenUrls.add(resolvedUrl);

    // Extract title if present
    const title = link.getAttribute("title");

    feeds.push({
      url: resolvedUrl,
      type: feedType,
      title: title || undefined,
    });
  }

  return feeds;
}

/**
 * Generates a list of common feed URLs to check for a given base URL.
 * Returns absolute URLs built from the origin of the base URL.
 *
 * @param baseUrl - The base URL to generate feed URLs from
 * @returns An array of absolute feed URLs to check
 *
 * @example
 * ```typescript
 * const urls = getCommonFeedUrls("https://example.com/blog/post");
 * // Returns: ["https://example.com/feed", "https://example.com/feed.xml", ...]
 * ```
 */
export function getCommonFeedUrls(baseUrl: string): string[] {
  try {
    const url = new URL(baseUrl);
    const origin = url.origin;
    return COMMON_FEED_PATHS.map((path) => `${origin}${path}`);
  } catch {
    return [];
  }
}
