/**
 * Full Content Fetching Service
 *
 * Fetches and extracts full article content from URLs using Readability.
 * Reuses patterns from saved articles for content fetching and cleaning.
 */

import { fetchHtmlPage, HttpFetchError } from "@/server/http/fetch";
import { cleanContent, absolutizeUrls } from "@/server/feed/content-cleaner";
import { logger } from "@/lib/logger";

/**
 * Result of fetching full article content.
 */
export interface FetchFullContentResult {
  /** Whether the fetch was successful */
  success: boolean;
  /** The raw HTML content from the URL */
  contentOriginal?: string;
  /** The Readability-cleaned HTML content */
  contentCleaned?: string;
  /** Error message if the fetch failed */
  error?: string;
}

/**
 * Fetches full article content from a URL.
 *
 * This function:
 * 1. Fetches the HTML from the URL
 * 2. Runs it through Readability to extract the article content
 * 3. Returns both the original HTML and the cleaned content
 *
 * @param url - The article URL to fetch
 * @returns The fetch result with content or error
 */
export async function fetchFullContent(url: string): Promise<FetchFullContentResult> {
  try {
    // Fetch the HTML page
    const html = await fetchHtmlPage(url);

    // Absolutize URLs in the original HTML
    const contentOriginal = absolutizeUrls(html, url);

    // Clean the content using Readability
    const cleaned = cleanContent(html, { url });

    if (!cleaned) {
      return {
        success: false,
        error: "Could not extract article content from page",
      };
    }

    return {
      success: true,
      contentOriginal,
      contentCleaned: cleaned.content,
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.warn("Failed to fetch full content", { url, error: errorMessage });

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Extracts a user-friendly error message from an error object.
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof HttpFetchError) {
    if (error.isBlocked()) {
      return "Site blocked the request";
    }
    return `HTTP ${error.status}: ${error.statusText}`;
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Request timed out";
    }
    return error.message;
  }

  return "Unknown error";
}
