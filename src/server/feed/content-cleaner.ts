/**
 * Content cleaning module using Mozilla Readability.
 *
 * Extracts and cleans article content from HTML using the Readability algorithm,
 * which removes navigation, ads, and other non-content elements.
 */

import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { parseHTML } from "linkedom";
import { logger } from "@/lib/logger";

/**
 * Attributes that may contain URLs that should be absolutized.
 */
const URL_ATTRIBUTES = ["src", "href", "poster", "srcset"] as const;

/**
 * Absolutizes all relative URLs in HTML content.
 *
 * Converts relative URLs in src, href, poster, and srcset attributes
 * to absolute URLs using the provided base URL.
 *
 * Uses linkedom for lightweight HTML parsing (much faster than JSDOM).
 *
 * @param html - The HTML content to process
 * @param baseUrl - The base URL for resolving relative URLs
 * @returns HTML with all relative URLs converted to absolute
 */
export function absolutizeUrls(html: string, baseUrl: string): string {
  try {
    // Use linkedom for lightweight parsing - much faster than JSDOM
    const { document } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);

    // Find all elements with URL attributes
    for (const attr of URL_ATTRIBUTES) {
      const elements = document.querySelectorAll(`[${attr}]`);

      for (const element of elements) {
        const value = element.getAttribute(attr);
        if (!value) continue;

        if (attr === "srcset") {
          // srcset has a special format: "url width, url width, ..."
          const absolutizedSrcset = absolutizeSrcset(value, baseUrl);
          element.setAttribute(attr, absolutizedSrcset);
        } else {
          // Regular URL attribute
          const absoluteUrl = resolveUrl(value, baseUrl);
          if (absoluteUrl && absoluteUrl !== value) {
            element.setAttribute(attr, absoluteUrl);
          }
        }
      }
    }

    // Return the body's innerHTML (we only care about the content, not the wrapper)
    return document.body.innerHTML;
  } catch (error) {
    logger.warn("Failed to absolutize URLs in content", {
      baseUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    // Return original HTML if absolutizing fails
    return html;
  }
}

/**
 * Resolves a potentially relative URL against a base URL.
 *
 * @param url - The URL to resolve (may be relative or absolute)
 * @param baseUrl - The base URL for resolution
 * @returns The absolute URL, or null if resolution fails
 */
function resolveUrl(url: string, baseUrl: string): string | null {
  try {
    // Skip data: URLs and javascript: URLs
    if (url.startsWith("data:") || url.startsWith("javascript:")) {
      return url;
    }

    const resolved = new URL(url, baseUrl);
    return resolved.href;
  } catch {
    return null;
  }
}

/**
 * Checks if a srcset entry ends with a descriptor (e.g., "1x", "2x", "480w").
 */
function hasDescriptor(entry: string): boolean {
  return /\s+\d+(\.\d+)?[wx]\s*$/.test(entry);
}

/**
 * Checks if a string looks like the start of a new srcset entry.
 * New entries start with URL schemes, absolute paths, or domain-like patterns.
 */
function looksLikeNewSrcsetEntry(str: string): boolean {
  return (
    str.startsWith("http://") ||
    str.startsWith("https://") ||
    str.startsWith("data:") ||
    str.startsWith("//") ||
    str.startsWith("/")
  );
}

/**
 * Absolutizes URLs in a srcset attribute value.
 *
 * srcset format: "url width, url width, ..." where width is optional
 * Example: "image.jpg 1x, image@2x.jpg 2x"
 *
 * This function handles URLs that contain commas (like Cloudinary URLs with
 * transformation parameters: f_auto,q_auto) by being smarter about how it
 * splits entries. It looks for descriptors (1x, 2x, 480w) to identify
 * entry boundaries, rather than naively splitting on all commas.
 *
 * @param srcset - The srcset attribute value
 * @param baseUrl - The base URL for resolution
 * @returns The srcset with absolute URLs
 */
function absolutizeSrcset(srcset: string, baseUrl: string): string {
  // Split on comma first
  const rawParts = srcset.split(",");

  // Rejoin parts that don't look like new srcset entries.
  // A comma inside a URL (like Cloudinary's f_auto,q_auto) should not split entries.
  // We identify entry boundaries by:
  // 1. The previous part ending with a descriptor (1x, 2x, 480w, etc.)
  // 2. The current part starting with a URL scheme or absolute path
  const entries: string[] = [];

  for (const raw of rawParts) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // First entry is always accepted
    if (entries.length === 0) {
      entries.push(trimmed);
      continue;
    }

    // Check if this should be a new entry or rejoined with previous
    const previousEntry = entries[entries.length - 1];
    const previousHasDescriptor = hasDescriptor(previousEntry);
    const currentLooksLikeNewEntry = looksLikeNewSrcsetEntry(trimmed);

    if (previousHasDescriptor || currentLooksLikeNewEntry) {
      // This is a new srcset entry
      entries.push(trimmed);
    } else {
      // This is a continuation of the previous entry (comma was inside URL)
      entries[entries.length - 1] += "," + trimmed;
    }
  }

  return entries
    .map((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (parts.length === 0) return entry;

      const url = parts[0];
      const descriptor = parts.slice(1).join(" ");

      const absoluteUrl = resolveUrl(url, baseUrl);
      if (absoluteUrl) {
        return descriptor ? `${absoluteUrl} ${descriptor}` : absoluteUrl;
      }
      return entry;
    })
    .join(", ");
}

/**
 * Result of content cleaning operation.
 */
export interface CleanedContent {
  /** Cleaned HTML content */
  content: string;
  /** Plain text content (HTML stripped) */
  textContent: string;
  /** Excerpt from the content */
  excerpt: string;
  /** Article title extracted by Readability */
  title: string | null;
  /** Author byline extracted by Readability */
  byline: string | null;
}

/**
 * Options for content cleaning.
 */
export interface CleanContentOptions {
  /** Base URL for resolving relative links */
  url?: string;
  /** Minimum content length to attempt cleaning (default: 140, Mozilla's default) */
  minContentLength?: number;
  /**
   * Minimum length for cleaned text content to be considered successful.
   * If the cleaned content is shorter than this, cleaning is considered failed
   * (e.g., JS-heavy pages that don't render server-side).
   * Default: 50 characters
   */
  minCleanedLength?: number;
}

/**
 * Cleans HTML content using Mozilla Readability.
 *
 * This function extracts the main article content from HTML, removing
 * navigation, ads, sidebars, and other non-content elements.
 *
 * @param html - The HTML content to clean
 * @param options - Cleaning options
 * @returns Cleaned content object, or null if cleaning fails
 *
 * @example
 * ```typescript
 * const result = cleanContent('<html><body><article>...</article></body></html>', {
 *   url: 'https://example.com/article'
 * });
 * if (result) {
 *   console.log(result.content); // Cleaned HTML
 *   console.log(result.textContent); // Plain text
 * }
 * ```
 */
export function cleanContent(
  html: string,
  options: CleanContentOptions = {}
): CleanedContent | null {
  const { url, minContentLength = 140, minCleanedLength = 50 } = options;

  // Skip very short content
  if (html.length < minContentLength) {
    logger.debug("Content too short for Readability", {
      length: html.length,
      minContentLength,
    });
    return null;
  }

  try {
    // Parse HTML into a DOM
    // Note: We explicitly don't fetch external resources to avoid blocking on slow/unresponsive servers
    const dom = new JSDOM(html, {
      url,
    });

    const document = dom.window.document;

    // Check if the content is likely readable
    // This is a fast heuristic check before running the full algorithm
    if (!isProbablyReaderable(document)) {
      logger.debug("Content is probably not readable", { url });
      // Continue anyway - feed content might still be extractable
    }

    // Create a clone of the document for Readability
    // (Readability modifies the DOM in place)
    const reader = new Readability(document, {
      // Keep styling classes that might be important for code blocks etc.
      keepClasses: true,
      // Character threshold for content detection
      charThreshold: 100,
    });

    const article = reader.parse();

    if (!article) {
      logger.debug("Readability failed to parse content", { url });
      return null;
    }

    // Ensure we have content
    if (!article.content || article.content.trim().length === 0) {
      logger.debug("Readability returned empty content", { url });
      return null;
    }

    // Check if cleaned content is unrealistically short (e.g., JS-heavy pages)
    const textContent = article.textContent?.trim() ?? "";
    if (textContent.length < minCleanedLength) {
      logger.debug("Readability extracted content too short", {
        url,
        textLength: textContent.length,
        minCleanedLength,
      });
      return null;
    }

    // Absolutize relative URLs in the cleaned content if we have a base URL
    const content = url ? absolutizeUrls(article.content, url) : article.content;

    return {
      content,
      textContent,
      excerpt: article.excerpt ?? "",
      title: article.title ?? null,
      byline: article.byline ?? null,
    };
  } catch (error) {
    // Log the error but don't throw - return null to indicate failure
    logger.warn("Readability parsing error", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Generates a summary from cleaned content.
 *
 * Uses the excerpt if available, otherwise truncates the text content.
 *
 * @param cleaned - The cleaned content result
 * @param maxLength - Maximum summary length (default: 300)
 * @returns Summary string
 */
export function generateCleanedSummary(cleaned: CleanedContent, maxLength = 300): string {
  // Prefer the excerpt if it's meaningful
  if (cleaned.excerpt && cleaned.excerpt.length >= 50) {
    return truncateText(cleaned.excerpt, maxLength);
  }

  // Fall back to truncated text content
  return truncateText(cleaned.textContent, maxLength);
}

/**
 * Truncates text to a maximum length, adding ellipsis if needed.
 * Attempts to break at word boundaries.
 */
function truncateText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  // Try to find a word boundary before the max length
  let truncated = trimmed.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");

  // If we found a space reasonably close to the end, use it
  if (lastSpace > maxLength - 50) {
    truncated = truncated.slice(0, lastSpace);
  }

  return truncated.trimEnd() + "...";
}

// ============================================================================
// Feed-Specific Content Cleaners
// ============================================================================

/**
 * Regex pattern for LessWrong's "Published on" date prefix.
 * Matches: "Published on [Month] [Day], [Year] [Time] [AM/PM] [Timezone]<br/><br/>"
 * The pattern is flexible about date format and <br> tag variations.
 *
 * Examples:
 * - "Published on January 7, 2026 2:39 AM GMT<br/><br/>"
 * - "Published on December 25, 2025 11:30 PM EST<br><br>"
 */
const LESSWRONG_PUBLISHED_ON_PATTERN =
  /^Published on [A-Za-z]+ \d{1,2}, \d{4} \d{1,2}:\d{2} [AP]M \w+<br\s*\/?>(<br\s*\/?>|\s)*/i;

/**
 * Checks if a feed URL is from LessWrong or LesserWrong.
 *
 * @param feedUrl - The feed URL to check
 * @returns True if this is a LessWrong or LesserWrong feed
 */
export function isLessWrongFeed(feedUrl: string | null | undefined): boolean {
  if (!feedUrl) return false;
  try {
    const url = new URL(feedUrl);
    const hostname = url.hostname.toLowerCase();
    return (
      hostname === "www.lesswrong.com" ||
      hostname === "lesswrong.com" ||
      hostname === "www.lesserwrong.com" ||
      hostname === "lesserwrong.com"
    );
  } catch {
    return false;
  }
}

/**
 * Strips the "Published on [date]<br/><br/>" prefix from LessWrong RSS content.
 *
 * LessWrong's RSS feed prepends publication date info to each article's content,
 * but we already get this from the pubDate field. This removes the redundant prefix.
 *
 * @param html - The HTML content from the RSS feed
 * @returns The content with the "Published on..." prefix removed
 */
export function cleanLessWrongContent(html: string): string {
  return html.replace(LESSWRONG_PUBLISHED_ON_PATTERN, "");
}
