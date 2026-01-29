import type { UrlPlugin, SavedArticleContent } from "./types";
import {
  isGoogleDocsUrl,
  extractDocId,
  normalizeGoogleDocsUrl,
  fetchGoogleDocsFromUrl,
} from "@/server/google/docs";
import { wrapHtmlFragment } from "@/server/http/html";
import { logger } from "@/lib/logger";

/**
 * Google Docs plugin using the Google Docs API for content extraction.
 *
 * Provides capabilities for:
 * - SavedArticle: Fetch Google Doc content from URLs
 *
 * The plugin supports both:
 * - Public documents (via service account)
 * - Private documents (via user OAuth, Phase 2)
 */
export const googleDocsPlugin: UrlPlugin = {
  name: "google-docs",
  hosts: ["docs.google.com"],

  matchUrl(url: URL): boolean {
    // Match /document/d/{docId} URLs
    return /^\/document\/d\/[a-zA-Z0-9_-]+/.test(url.pathname);
  },

  capabilities: {
    savedArticle: {
      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        try {
          // Validate it's a Google Docs URL
          if (!isGoogleDocsUrl(url.href)) {
            return null;
          }

          const docId = extractDocId(url.href);
          if (!docId) {
            return null;
          }

          // Fetch the document content
          const content = await fetchGoogleDocsFromUrl(url.href);
          if (!content) {
            return null;
          }

          // Normalize the URL to use as canonical
          const canonical = normalizeGoogleDocsUrl(url.href);
          const title = content.title || null;

          return {
            html: wrapHtmlFragment(content.html, title),
            title,
            author: content.author || null,
            publishedAt: content.modifiedAt || null,
            canonicalUrl: canonical,
          };
        } catch (error) {
          logger.warn("Failed to fetch Google Docs content", {
            url: url.href,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },

      skipReadability: true, // Google Docs API content is already clean HTML
      siteName: "Google Docs",
    },
  },
};
