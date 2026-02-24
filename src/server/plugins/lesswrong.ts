import type { UrlPlugin, SavedArticleContent } from "./types";
import {
  fetchLessWrongContentFromUrl,
  fetchLessWrongUserBySlug,
  fetchLessWrongUserById,
  buildLessWrongUserFeedUrl,
} from "@/server/feed/lesswrong";
import { cleanLessWrongContent } from "@/server/feed/content-cleaner";
import { wrapHtmlFragment } from "@/server/http/html";
import { logger } from "@/lib/logger";

/**
 * LessWrong plugin using the GraphQL API for full content fetching.
 *
 * Provides capabilities for:
 * - Feed: Transform user profiles to RSS feeds, clean entry content
 * - SavedArticle: Fetch full post/comment content via GraphQL API
 */
export const lessWrongPlugin: UrlPlugin = {
  name: "lesswrong",
  hosts: ["lesswrong.com", "www.lesswrong.com", "lesserwrong.com", "www.lesserwrong.com"],

  matchUrl(url: URL): boolean {
    // Match posts (/posts/[id]), comments (?commentId=), and users (/users/[slug])
    return /^\/(posts|users)\//.test(url.pathname) || url.searchParams.has("commentId");
  },

  feedBuilderUrl: "https://brendanlong.github.io/lesswrong-rss-builder/",

  capabilities: {
    feed: {
      async transformToFeedUrl(url: URL): Promise<URL | null> {
        // Transform user profile URL to feed URL
        const userMatch = url.pathname.match(/^\/users\/([a-zA-Z0-9_-]+)/);
        if (!userMatch) return null;

        try {
          const user = await fetchLessWrongUserBySlug(userMatch[1]);
          if (!user) return null;

          return new URL(buildLessWrongUserFeedUrl(user.userId));
        } catch (error) {
          logger.warn("Failed to transform LessWrong user URL to feed URL", {
            url: url.href,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },

      cleanEntryContent(html: string): string {
        // Strip "Published on January 7, 2026 2:39 AM GMT<br/><br/>" prefix
        return cleanLessWrongContent(html);
      },

      async transformFeedTitle(title: string, feedUrl: URL): Promise<string> {
        const userId = feedUrl.searchParams.get("userId");
        if (!userId) return title;

        try {
          const user = await fetchLessWrongUserById(userId);
          if (!user?.displayName) return title;

          return `${title} - ${user.displayName}`;
        } catch (error) {
          logger.warn("Failed to transform LessWrong feed title", {
            feedUrl: feedUrl.href,
            error: error instanceof Error ? error.message : String(error),
          });
          return title;
        }
      },

      siteName: "LessWrong",
    },

    savedArticle: {
      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        try {
          const content = await fetchLessWrongContentFromUrl(url.href);
          if (!content) return null;

          // Handle both posts and comments (which have different title fields)
          const title =
            content.type === "post"
              ? content.title
              : content.type === "comment"
                ? content.postTitle
                : null;

          return {
            html: wrapHtmlFragment(content.html, title),
            title: title || null,
            author: content.author || null,
            publishedAt: content.publishedAt || null,
            canonicalUrl: content.url || url.href,
          };
        } catch (error) {
          logger.warn("Failed to fetch LessWrong saved article content", {
            url: url.href,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },

      skipReadability: true, // GraphQL content is already clean
      siteName: "LessWrong",
    },
  },
};
