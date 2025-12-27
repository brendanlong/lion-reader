/**
 * Content cleaning module using Mozilla Readability.
 *
 * Extracts and cleans article content from HTML using the Readability algorithm,
 * which removes navigation, ads, and other non-content elements.
 */

import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { logger } from "@/lib/logger";

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

    return {
      content: article.content,
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
