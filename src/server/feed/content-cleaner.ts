/**
 * Content cleaning module using the Readability algorithm.
 *
 * Extracts and cleans article content from HTML, removing navigation, ads,
 * and other non-content elements. The extraction engine is the native
 * @lion-reader/readability module (dom_smoothie, a Rust port of Mozilla
 * Readability) — ~5x faster and ~10x lighter than the old
 * linkedom + @mozilla/readability pipeline.
 */

import { extractArticle, extractArticleAsync } from "@lion-reader/readability";
import type { ExtractedArticle, ExtractOptions } from "@lion-reader/readability";
import { HTMLRewriter } from "html-rewriter-wasm";
import { logger } from "@/lib/logger";
import { sanitizeEntryHtmlAsync } from "@/server/html/sanitize";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Absolutizes all relative URLs in HTML content.
 *
 * Converts relative URLs in src, href, poster, and srcset attributes
 * to absolute URLs using the provided base URL.
 *
 * Uses html-rewriter-wasm for streaming transformation (much faster than DOM parsing).
 *
 * @param html - The HTML content to process
 * @param baseUrl - The base URL for resolving relative URLs
 * @returns HTML with all relative URLs converted to absolute
 */
export function absolutizeUrls(html: string, baseUrl: string): string {
  try {
    let output = "";
    const rewriter = new HTMLRewriter((chunk) => {
      output += decoder.decode(chunk);
    });

    // Effective base URL - may be overridden by a <base href="..."> tag.
    // Since html-rewriter-wasm processes elements in document order,
    // <base> in <head> will be seen before any body elements.
    // Per the HTML spec, only the first <base> with an href is used.
    let effectiveBaseUrl = baseUrl;
    let baseHrefSet = false;

    // Check for <base> tag and use its href as the base URL
    rewriter.on("base[href]", {
      element(el) {
        if (baseHrefSet) return;

        const href = el.getAttribute("href");
        if (href) {
          // Resolve the <base> href against the provided baseUrl,
          // in case <base href> itself is relative
          const resolved = resolveUrl(href, baseUrl);
          if (resolved) {
            effectiveBaseUrl = resolved;
            baseHrefSet = true;
          }
        }
      },
    });

    // Handle elements with URL attributes
    rewriter.on("[src]", {
      element(el) {
        const value = el.getAttribute("src");
        if (value) {
          const absolute = resolveUrl(value, effectiveBaseUrl);
          if (absolute && absolute !== value) {
            el.setAttribute("src", absolute);
          }
        }
      },
    });

    rewriter.on("[href]", {
      element(el) {
        // Don't rewrite the <base> tag's own href
        if (el.tagName === "base") return;
        const value = el.getAttribute("href");
        if (value) {
          const absolute = resolveUrl(value, effectiveBaseUrl);
          if (absolute && absolute !== value) {
            el.setAttribute("href", absolute);
          }
        }
      },
    });

    rewriter.on("[poster]", {
      element(el) {
        const value = el.getAttribute("poster");
        if (value) {
          const absolute = resolveUrl(value, effectiveBaseUrl);
          if (absolute && absolute !== value) {
            el.setAttribute("poster", absolute);
          }
        }
      },
    });

    rewriter.on("[srcset]", {
      element(el) {
        const value = el.getAttribute("srcset");
        if (value) {
          el.setAttribute("srcset", absolutizeSrcset(value, effectiveBaseUrl));
        }
      },
    });

    try {
      rewriter.write(encoder.encode(html));
      rewriter.end();
    } finally {
      rewriter.free();
    }

    return output;
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
 * Extracts the effective base URL from HTML content by looking for a <base href="..."> tag.
 *
 * Per the HTML spec, only the first <base> element with an href attribute is used.
 * The href is resolved against the provided fallback URL.
 *
 * This is useful for extracting the base URL before processing that may strip
 * the <base> tag (e.g. Readability), so relative URLs can still be resolved correctly.
 *
 * @param html - The HTML content to search
 * @param fallbackUrl - The URL to use if no <base> tag is found, also used to resolve
 *                      relative <base href> values
 * @returns The effective base URL (from <base> tag or fallback)
 */
export function extractBaseHref(html: string, fallbackUrl: string): string {
  // Use a simple regex to extract the first <base href="..."> value.
  // This is intentionally simple - we only need the first one per the HTML spec,
  // and we want this to be fast since it runs before Readability.
  const match = html.match(/<base\s[^>]*href\s*=\s*["']([^"']+)["']/i);
  if (!match) {
    return fallbackUrl;
  }

  try {
    // Resolve the <base> href against the fallback URL in case it's relative
    return new URL(match[1], fallbackUrl).href;
  } catch {
    return fallbackUrl;
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
    // Skip data:, javascript:, and vbscript: URLs
    if (url.startsWith("data:") || url.startsWith("javascript:") || url.startsWith("vbscript:")) {
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
  if (!passesMinContentLength(html, options)) return null;

  try {
    return finishCleaned(extractArticle(html, EXTRACT_OPTIONS), html, options);
  } catch (error) {
    // Log the error but don't throw - return null to indicate failure
    logger.warn("Readability parsing error", {
      url: options.url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Async form of `cleanContent`: extraction runs on the libuv thread pool so
 * large pages never block the event loop. Small inputs run synchronously —
 * the native extractor finishes in well under a millisecond for them, so the
 * fixed cost of scheduling a thread-pool task isn't worth paying (mirroring
 * `sanitizeEntryHtmlAsync`).
 *
 * Intended for app-server request paths (saved articles, on-demand
 * full-content fetch). Background jobs (feed fetching, email ingest)
 * deliberately use the synchronous `cleanContent` — they already run off the
 * request path, so the async hop would be pure overhead.
 */
export async function cleanContentAsync(
  html: string,
  options: CleanContentOptions = {}
): Promise<CleanedContent | null> {
  if (!passesMinContentLength(html, options)) return null;
  if (html.length <= CLEAN_INLINE_MAX_CHARS) {
    return cleanContent(html, options);
  }

  try {
    return finishCleaned(await extractArticleAsync(html, EXTRACT_OPTIONS), html, options);
  } catch (error) {
    logger.warn("Readability parsing error", {
      url: options.url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * `cleanContentAsync` plus a sanitize of the cleaned output (also async, via
 * the native sanitizer), so a caller that persists the cleaned content
 * doesn't sanitize it again — the result is returned as `contentSanitized`
 * and handed to `withSanitizedEntryContentAsync` as a `presanitized` hint.
 * Each step is one native call; composing them costs a single extra N-API
 * string copy (~1% of the work), which is why there's no fused native task.
 *
 * Same audience as `cleanContentAsync`: app-server request paths (saved
 * articles, on-demand full-content fetch).
 */
export async function cleanContentSanitizedAsync(
  html: string,
  options: CleanContentOptions = {}
): Promise<(CleanedContent & { contentSanitized: string | null }) | null> {
  const cleaned = await cleanContentAsync(html, options);
  if (!cleaned) return null;
  return { ...cleaned, contentSanitized: await sanitizeEntryHtmlAsync(cleaned.content) };
}

/**
 * Inputs at or below this size run the extractor synchronously in
 * `cleanContentAsync` instead of scheduling a libuv-thread-pool task. ~10 KB,
 * same rationale and value as the sanitizer's inline threshold.
 */
const CLEAN_INLINE_MAX_CHARS = 10 * 1024;

const EXTRACT_OPTIONS: ExtractOptions = {
  // Keep styling classes that might be important for code blocks etc.
  keepClasses: true,
  // Character threshold for content detection
  charThreshold: 100,
};

/** Shared pre-gate: skip very short content. */
function passesMinContentLength(html: string, options: CleanContentOptions): boolean {
  const { minContentLength = 140 } = options;
  if (html.length < minContentLength) {
    logger.debug("Content too short for Readability", {
      length: html.length,
      minContentLength,
    });
    return false;
  }
  return true;
}

/**
 * Shared post-processing for the sync and async extraction paths: quality
 * gates, URL absolutization, and mapping to the CleanedContent shape.
 */
function finishCleaned(
  article: ExtractedArticle | null,
  html: string,
  options: CleanContentOptions
): CleanedContent | null {
  const { url, minCleanedLength = 50 } = options;

  if (!article) {
    logger.debug("Readability failed to parse content", { url });
    return null;
  }

  // The fast is-probably-readable heuristic is informational only — the old
  // pipeline also continued on a negative result (feed content might still
  // be extractable), so extraction always ran; keep the log for parity.
  if (!article.probablyReadable) {
    logger.debug("Content is probably not readable", { url });
  }

  // Ensure we have content
  if (!article.content || article.content.trim().length === 0) {
    logger.debug("Readability returned empty content", { url });
    return null;
  }

  // Check if cleaned content is unrealistically short (e.g., JS-heavy pages)
  const textContent = article.textContent.trim();
  if (textContent.length < minCleanedLength) {
    logger.debug("Readability extracted content too short", {
      url,
      textLength: textContent.length,
      minCleanedLength,
    });
    return null;
  }

  // Absolutize relative URLs in the cleaned content if we have a base URL.
  // Extract <base href> from the raw HTML since Readability strips it.
  const effectiveUrl = url ? extractBaseHref(html, url) : undefined;
  const content = effectiveUrl ? absolutizeUrls(article.content, effectiveUrl) : article.content;

  return {
    content,
    textContent,
    excerpt: article.excerpt ?? "",
    title: article.title ?? null,
    byline: article.byline ?? null,
  };
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
