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
import {
  absolutizeUrls as nativeAbsolutizeUrls,
  absolutizeUrlsAsync as nativeAbsolutizeUrlsAsync,
} from "@lion-reader/sanitizer";
import type { AbsolutizeOptions, AbsolutizeOutput } from "@lion-reader/sanitizer";
import { logger } from "@/lib/logger";
import { startReadabilityTimer } from "@/server/metrics/metrics";

/**
 * Absolutizes relative URLs in `src`, `href`, `poster` and `srcset` (rules in
 * `native/sanitizer/core/src/absolutize.rs`), returning the input unchanged if
 * lol_html can't parse it.
 */
export function absolutizeUrls(
  html: string,
  baseUrl: string,
  options: AbsolutizeOptions = {}
): string {
  return rewriteContentUrls(html, baseUrl, options).html;
}

/**
 * {@link absolutizeUrls}, except that a null `baseUrl` leaves relative URLs as
 * written, and with `options.imageUrlPrefix` it also moves inlined images out
 * of the HTML, returning them to store (`rewrite_urls` in
 * `native/sanitizer/core/src/absolutize.rs`). If lol_html can't parse the
 * input, returns it unchanged, with no images.
 */
export function rewriteContentUrls(
  html: string,
  baseUrl: string | null,
  options: AbsolutizeOptions = {}
): AbsolutizeOutput {
  try {
    return nativeAbsolutizeUrls(html, baseUrl, options);
  } catch (error) {
    return absolutizeFailed(html, baseUrl, error);
  }
}

/**
 * Async form of {@link rewriteContentUrls} for request paths: inputs over
 * {@link INLINE_MAX_CHARS} run on the libuv thread pool.
 */
export async function rewriteContentUrlsAsync(
  html: string,
  baseUrl: string | null,
  options: AbsolutizeOptions = {}
): Promise<AbsolutizeOutput> {
  if (html.length <= INLINE_MAX_CHARS) {
    return rewriteContentUrls(html, baseUrl, options);
  }
  try {
    return await nativeAbsolutizeUrlsAsync(html, baseUrl, options);
  } catch (error) {
    return absolutizeFailed(html, baseUrl, error);
  }
}

function absolutizeFailed(html: string, baseUrl: string | null, error: unknown): AbsolutizeOutput {
  logger.warn("Failed to absolutize URLs in content", {
    baseUrl,
    error: error instanceof Error ? error.message : String(error),
  });
  return { html, images: [] };
}

/**
 * The first `<base href>`. The attribute run is `[^<>]*`, not `[^>]*`: with
 * `[^>]*`, a page of `<base ` repeated without a `>` makes every attempt scan
 * to the end of the input — quadratic, seconds per 100 KB of attacker HTML.
 */
const BASE_HREF_PATTERN = /<base\s[^<>]*href\s*=\s*["']([^"']+)["']/i;

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
  const match = BASE_HREF_PATTERN.exec(html);
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
    const stopTimer = startReadabilityTimer();
    let article: ExtractedArticle | null;
    try {
      article = extractArticle(html, EXTRACT_OPTIONS);
    } finally {
      stopTimer();
    }
    return finishCleaned(article, html, options);
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
  // Small inputs run through the sync path, which records its own timing.
  if (html.length <= INLINE_MAX_CHARS) {
    return cleanContent(html, options);
  }

  try {
    const stopTimer = startReadabilityTimer();
    let article: ExtractedArticle | null;
    try {
      article = await extractArticleAsync(html, EXTRACT_OPTIONS);
    } finally {
      stopTimer();
    }
    return finishCleaned(article, html, options);
  } catch (error) {
    logger.warn("Readability parsing error", {
      url: options.url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Inputs at or below this size run synchronously in the `*Async` forms instead
 * of scheduling a libuv-thread-pool task. ~10 KB, same rationale and value as
 * the sanitizer's inline threshold.
 */
const INLINE_MAX_CHARS = 10 * 1024;

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
