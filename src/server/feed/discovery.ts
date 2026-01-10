/**
 * Feed discovery from HTML pages.
 * Parses HTML to find <link rel="alternate"> tags pointing to RSS/Atom/JSON feeds.
 *
 * Uses htmlparser2 SAX parsing for efficiency - exits early after </head>
 * since feed links are only in the head section.
 */

import { Parser } from "htmlparser2";

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
 * Gets an attribute value case-insensitively from an attributes object.
 *
 * @param attribs - The attributes object from htmlparser2
 * @param name - The attribute name (lowercase)
 * @returns The attribute value, or undefined if not found
 */
function getAttributeCI(attribs: Record<string, string>, name: string): string | undefined {
  // Try lowercase first (most common case)
  if (name in attribs) return attribs[name];

  // Try uppercase
  const upperName = name.toUpperCase();
  if (upperName in attribs) return attribs[upperName];

  return undefined;
}

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
 * Uses SAX parsing for efficiency and exits early after </head>.
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

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tagName = name.toLowerCase();

        // Check for link tags
        if (tagName === "link") {
          // Check if this is a rel="alternate" link
          const rel = getAttributeCI(attribs, "rel");
          if (!isAlternateRel(rel)) {
            return;
          }

          // Check if the type is a feed type
          const type = getAttributeCI(attribs, "type");
          const feedType = getFeedTypeFromMime(type);
          if (feedType === null) {
            return;
          }

          // Extract and resolve the href
          const href = getAttributeCI(attribs, "href");
          const resolvedUrl = resolveUrl(href, baseUrl);
          if (!resolvedUrl) {
            return;
          }

          // Skip duplicates
          if (seenUrls.has(resolvedUrl)) {
            return;
          }
          seenUrls.add(resolvedUrl);

          // Extract title if present
          const title = getAttributeCI(attribs, "title");

          feeds.push({
            url: resolvedUrl,
            type: feedType,
            title: title || undefined,
          });
        }
      },
      onclosetag(name) {
        // Exit early after </head> - no feed links in body
        if (name.toLowerCase() === "head") {
          parser.pause();
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: false, lowerCaseAttributeNames: false }
  );

  parser.write(html);
  parser.end();

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
