import type { UrlPlugin, SavedArticleContent } from "./types";
import { getArxivFetchUrl } from "@/server/feed/arxiv";
import { fetchHtmlPage } from "@/server/http/fetch";
import { logger } from "@/lib/logger";

/**
 * ArXiv plugin for fetching papers in optimal format.
 *
 * Provides capability for:
 * - SavedArticle: Fetch ArXiv papers, preferring HTML version when available
 *
 * ArXiv papers are available in multiple formats (abs, pdf, html).
 * The plugin attempts to fetch the HTML version for better reading,
 * falling back to the abstract page if HTML isn't available.
 */
export const arxivPlugin: UrlPlugin = {
  name: "arxiv",
  hosts: ["arxiv.org", "www.arxiv.org"],

  matchUrl(url: URL): boolean {
    // Match /abs/, /pdf/, /html/ URLs
    return /^\/(abs|pdf|html)\//.test(url.pathname);
  },

  capabilities: {
    savedArticle: {
      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        try {
          // For /html/ URLs, fetch directly; for /abs/ and /pdf/, try to find the HTML version
          const isHtmlUrl = /^\/html\//.test(url.pathname);
          let fetchUrl: string;

          if (isHtmlUrl) {
            // Already an HTML URL - fetch it directly
            fetchUrl = url.href;
          } else {
            // Try to transform abs/pdf to HTML
            const transformed = await getArxivFetchUrl(url.href);
            if (!transformed) {
              return null;
            }
            fetchUrl = transformed;
          }

          logger.debug("Fetching ArXiv paper", {
            originalUrl: url.href,
            fetchUrl: fetchUrl,
            isHtmlVersion: fetchUrl.includes("/html/"),
          });

          // Fetch the content
          const result = await fetchHtmlPage(fetchUrl);
          if (!result.content) {
            return null;
          }

          return {
            html: result.content,
            title: null, // Let Readability extract title
            author: null,
            publishedAt: null,
            canonicalUrl: result.finalUrl,
          };
        } catch (error) {
          logger.warn("Failed to fetch ArXiv paper", {
            url: url.href,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },

      skipReadability: false, // Still want cleanup with Readability
      siteName: "arXiv",
    },
  },
};
