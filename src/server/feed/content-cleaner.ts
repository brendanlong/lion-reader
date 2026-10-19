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
import { rewriteAttributes } from "@lion-reader/sanitizer";
import { logger } from "@/lib/logger";
import { startReadabilityTimer } from "@/server/metrics/metrics";

const URL_ATTRIBUTES = ["src", "href", "poster", "srcset"];

/**
 * Absolutizes all relative URLs in HTML content.
 *
 * Converts relative URLs in src, href, poster, and srcset attributes
 * to absolute URLs using the provided base URL.
 *
 * Streams through the native lol_html rewriter (much faster than DOM parsing).
 *
 * @param html - The HTML content to process
 * @param baseUrl - The base URL for resolving relative URLs
 * @param options.rootBaseUrl - Directory URL that root-relative paths
 *   (`/a/b.png`) resolve against, instead of the origin root that ordinary URL
 *   semantics would give. For sources that serve a document tree under a path
 *   prefix and read a leading slash as relative to that tree's root rather than
 *   the origin's (a GitHub repo — see `absolutizeGitHubUrls`).
 * @param options.media - Separate bases for the embedded-resource attributes
 *   (`src`, `poster`, `srcset` — so `img`/`video`/`audio`, but also
 *   `iframe`/`source`/`embed`); the whole pair defaults to the document's.
 *   Needed for sources that serve a document and the files it embeds from
 *   different origins — see `absolutizeGitHubUrls` in
 *   `src/server/plugins/github.ts`. The two bases travel together so a caller
 *   can't point media at another origin and leave its root base behind on this
 *   one, which is the bug this option exists to prevent.
 * @returns HTML with all relative URLs converted to absolute
 */
export function absolutizeUrls(
  html: string,
  baseUrl: string,
  options: {
    rootBaseUrl?: string;
    media?: { baseUrl: string; rootBaseUrl?: string };
  } = {}
): string {
  // Effective bases - may be overridden by a <base href="..."> tag. The
  // rewriter visits elements in document order, so <base> in <head> is seen
  // before any body elements. Per the HTML spec, only the first <base> with an
  // href is used.
  let documentBase: ResolveBase = { url: baseUrl, root: options.rootBaseUrl };
  let mediaBase: ResolveBase = options.media
    ? { url: options.media.baseUrl, root: options.media.rootBaseUrl }
    : documentBase;
  let baseHrefSet = false;

  try {
    return rewriteAttributes(html, URL_ATTRIBUTES, (tagName, name, value) => {
      if (tagName === "base" && name === "href") {
        // A fragment-only <base href> means "this document", so it leaves the
        // base unchanged — and `resolveUrl` passes fragments through, which
        // would otherwise make it the base and break every later resolution.
        if (!baseHrefSet && value && !value.startsWith("#")) {
          // Resolve the <base> href against the provided baseUrl,
          // in case <base href> itself is relative
          const resolved = resolveUrl(value, { url: baseUrl });
          if (resolved) {
            // <base href> governs both kinds of URL, so it replaces the media
            // bases too — but only for the elements that follow it, since this
            // is a single streaming pass (see above). It also restores plain
            // HTML semantics for root-relative paths, so the root bases are
            // dropped.
            documentBase = { url: resolved };
            mediaBase = { url: resolved };
            baseHrefSet = true;
          }
        }
        // Don't rewrite the <base> tag's own href
        return null;
      }
      if (!value) return null;
      switch (name) {
        case "href":
          return resolveUrl(value, documentBase);
        case "srcset":
          return absolutizeSrcset(value, mediaBase);
        default:
          return resolveUrl(value, mediaBase);
      }
    });
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
 * Where to resolve relative URLs to: `url` is the ordinary base, and `root` — if
 * the source reads a leading slash as relative to a subtree rather than the
 * origin — is the directory URL root-relative paths resolve against instead.
 */
interface ResolveBase {
  url: string;
  root?: string;
}

/**
 * Resolves a potentially relative URL against a base.
 *
 * @param url - The URL to resolve (may be relative or absolute)
 * @param base - The base(s) for resolution
 * @returns The absolute URL, or null if resolution fails
 */
function resolveUrl(url: string, base: ResolveBase): string | null {
  try {
    // The URL parser ignores surrounding whitespace, so match its view of the
    // value rather than the raw attribute when classifying below.
    const trimmed = url.trim();

    // Skip data:, javascript:, and vbscript: URLs
    if (
      trimmed.startsWith("data:") ||
      trimmed.startsWith("javascript:") ||
      trimmed.startsWith("vbscript:")
    ) {
      return url;
    }

    // Leave same-document fragments (`#footnote-1`, `#bib.bib19`) relative.
    // Their target is an `id` in this very entry, which survives sanitization,
    // so absolutizing would send the reader off-site — and, because the href
    // would then be absolute, the sanitizer would also add `target="_blank"`
    // and open a new tab for what should be a scroll (#1425).
    //
    // The trade-off: in a *truncated* excerpt feed the target may only exist on
    // the source page, so such a link now dead-ends instead of navigating there.
    // Full-text entries (arXiv citations, footnotes, Markdown tables of
    // contents) are much the more common case, and for them absolutizing broke
    // every anchor.
    if (trimmed.startsWith("#")) {
      return url;
    }

    // A root-relative path resolves to the base's origin root, which is wrong
    // for sources whose root is a subtree (a GitHub repo, #1423). Strip the
    // leading slash and resolve against that subtree instead. `//host/path` is
    // protocol-relative, not root-relative, so it's left to ordinary handling.
    if (base.root && trimmed.startsWith("/") && !trimmed.startsWith("//")) {
      return new URL(trimmed.slice(1), asDirectoryUrl(base.root)).href;
    }

    const resolved = new URL(url, base.url);
    return resolved.href;
  } catch {
    return null;
  }
}

/**
 * Ensures a base URL ends in a slash, so relative paths resolve *under* it
 * instead of replacing its last segment.
 */
function asDirectoryUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Checks if a srcset entry ends with a descriptor (e.g., "1x", "2x", "480w").
 */
function hasDescriptor(entry: string): boolean {
  // `\s`, not `\s+`: an unanchored leading `\s+` rescans a whitespace run from
  // each of its positions, quadratic on a long one.
  return /\s\d+(\.\d+)?[wx]\s*$/.test(entry);
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
 * @param base - The base(s) for resolution
 * @returns The srcset with absolute URLs
 */
function absolutizeSrcset(srcset: string, base: ResolveBase): string {
  // Split on comma first
  const rawParts = srcset.split(",");

  // Rejoin parts that don't look like new srcset entries.
  // A comma inside a URL (like Cloudinary's f_auto,q_auto) should not split entries.
  // We identify entry boundaries by:
  // 1. The previous part ending with a descriptor (1x, 2x, 480w, etc.)
  // 2. The current part starting with a URL scheme or absolute path
  const entries: string[] = [];
  // Whether the previous entry ends with a descriptor. Its last part decides
  // that (a descriptor can't span a comma), so test each part once rather than
  // re-testing an entry that grows with every rejoined part — quadratic.
  let previousHasDescriptor = false;

  for (const raw of rawParts) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // First entry is always accepted; otherwise check if this should be a new
    // entry or rejoined with previous
    if (entries.length === 0 || previousHasDescriptor || looksLikeNewSrcsetEntry(trimmed)) {
      // This is a new srcset entry
      entries.push(trimmed);
    } else {
      // This is a continuation of the previous entry (comma was inside URL)
      entries[entries.length - 1] += "," + trimmed;
    }
    previousHasDescriptor = hasDescriptor(trimmed);
  }

  return entries
    .map((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (parts.length === 0) return entry;

      const url = parts[0];
      const descriptor = parts.slice(1).join(" ");

      const absoluteUrl = resolveUrl(url, base);
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
  if (html.length <= CLEAN_INLINE_MAX_CHARS) {
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
