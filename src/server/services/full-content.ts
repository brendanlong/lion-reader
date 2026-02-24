/**
 * Full Content Fetching Service
 *
 * Fetches and extracts full article content from URLs using Readability.
 * Attempts to use plugins (LessWrong GraphQL, Google Docs API, etc.) first,
 * then falls back to standard HTML fetching and Readability.
 */

import { fetchHtmlPage, HttpFetchError } from "@/server/http/fetch";
import { cleanContent, absolutizeUrls } from "@/server/feed/content-cleaner";
import { pluginRegistry } from "@/server/plugins";
import { logger } from "@/lib/logger";
import { processMarkdown } from "@/server/markdown";

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
 * 1. Checks if there's a plugin that can handle the URL (LessWrong GraphQL, etc.)
 * 2. Falls back to standard HTML fetching + Readability if no plugin matches
 * 3. Returns both the original HTML and the cleaned content
 *
 * @param url - The article URL to fetch
 * @returns The fetch result with content or error
 */
export async function fetchFullContent(url: string): Promise<FetchFullContentResult> {
  try {
    const urlObj = new URL(url);

    // Check if there's a plugin that can handle this URL
    const plugin = pluginRegistry.findWithCapability(urlObj, "savedArticle");

    if (plugin) {
      logger.debug("Using plugin for full content fetch", {
        url,
        plugin: plugin.name,
      });

      try {
        const pluginContent = await plugin.capabilities.savedArticle.fetchContent(urlObj);

        if (pluginContent) {
          logger.debug("Plugin successfully fetched content", {
            url,
            plugin: plugin.name,
          });

          const html = pluginContent.html;
          const resolveUrl = pluginContent.canonicalUrl || url;

          const contentOriginal = absolutizeUrls(html, resolveUrl);

          // Respect plugin's skipReadability setting
          if (plugin.capabilities.savedArticle.skipReadability) {
            return {
              success: true,
              contentOriginal,
            };
          }

          // Run Readability on plugin content
          const cleaned = cleanContent(html, { url: resolveUrl });

          return {
            success: true,
            contentOriginal,
            contentCleaned: cleaned?.content,
          };
        }
      } catch (error) {
        logger.warn("Plugin fetch failed, falling back to standard fetching", {
          url,
          plugin: plugin.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fall back to standard HTML fetching + Readability
    logger.debug("Fetching full content using standard method", { url });

    const result = await fetchHtmlPage(url);
    const resolveUrl = result.finalUrl;

    // If we got Markdown, convert it to HTML and skip Readability
    // Markdown is already clean content, no need for article extraction
    if (result.isMarkdown) {
      logger.debug("Converting Markdown to HTML (skipping Readability)", { url });
      const { html: contentCleaned } = await processMarkdown(result.content);

      // Absolutize URLs in the original HTML (before title stripping)
      const contentOriginal = absolutizeUrls(contentCleaned, resolveUrl);

      return {
        success: true,
        contentOriginal,
        contentCleaned,
      };
    }

    // For HTML, absolutize URLs in the original
    const html = result.content;
    const contentOriginal = absolutizeUrls(html, resolveUrl);

    // Clean the content using Readability
    const cleaned = cleanContent(html, { url: resolveUrl });

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
