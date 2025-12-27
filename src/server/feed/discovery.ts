/**
 * Feed discovery from HTML pages.
 * Parses HTML to find <link rel="alternate"> tags pointing to RSS/Atom feeds.
 */

/**
 * A discovered feed from an HTML page.
 */
export interface DiscoveredFeed {
  /** The URL of the feed (resolved to absolute) */
  url: string;
  /** The type of feed (rss, atom, or unknown) */
  type: "rss" | "atom" | "unknown";
  /** The title of the feed (from title attribute, if present) */
  title?: string;
}

/**
 * Known feed MIME types and their corresponding feed types.
 */
const FEED_MIME_TYPES: Record<string, DiscoveredFeed["type"]> = {
  "application/rss+xml": "rss",
  "application/atom+xml": "atom",
  "application/xml": "unknown",
  "text/xml": "unknown",
};

/**
 * Regular expression to match <link> tags in HTML.
 * Captures the entire tag content for attribute extraction.
 * Handles self-closing and regular link tags.
 */
const LINK_TAG_REGEX = /<link\s+([^>]*?)(?:\/?>|>)/gi;

/**
 * Regular expression to extract an attribute value.
 * Handles double-quoted, single-quoted, and unquoted values.
 */
function getAttributeRegex(attrName: string): RegExp {
  return new RegExp(`${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
}

/**
 * Extracts an attribute value from a tag's attribute string.
 *
 * @param attributes - The attribute string from within a tag
 * @param attrName - The attribute name to extract
 * @returns The attribute value, or undefined if not found
 */
function extractAttribute(attributes: string, attrName: string): string | undefined {
  const regex = getAttributeRegex(attrName);
  const match = regex.exec(attributes);
  if (!match) {
    return undefined;
  }
  // Return whichever capture group matched (double-quoted, single-quoted, or unquoted)
  return match[1] ?? match[2] ?? match[3];
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

  // Find all link tags
  let match: RegExpExecArray | null;
  while ((match = LINK_TAG_REGEX.exec(html)) !== null) {
    const attributes = match[1];

    // Check if this is a rel="alternate" link
    const rel = extractAttribute(attributes, "rel");
    if (!isAlternateRel(rel)) {
      continue;
    }

    // Check if the type is a feed type
    const type = extractAttribute(attributes, "type");
    const feedType = getFeedTypeFromMime(type);
    if (feedType === null) {
      continue;
    }

    // Extract and resolve the href
    const href = extractAttribute(attributes, "href");
    const resolvedUrl = resolveUrl(href, baseUrl);
    if (!resolvedUrl) {
      continue;
    }

    // Skip duplicates
    if (seenUrls.has(resolvedUrl)) {
      continue;
    }
    seenUrls.add(resolvedUrl);

    // Extract title if present
    const title = extractAttribute(attributes, "title");

    feeds.push({
      url: resolvedUrl,
      type: feedType,
      title: title || undefined,
    });
  }

  return feeds;
}
