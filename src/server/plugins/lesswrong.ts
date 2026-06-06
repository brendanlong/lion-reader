import type { UrlPlugin, SavedArticleContent, FeedTitleContext } from "./types";
import {
  fetchLessWrongContentFromUrl,
  fetchLessWrongUserBySlug,
  fetchLessWrongPostMetadata,
  buildLessWrongUserFeedUrl,
  buildLessWrongPostCommentFeedUrl,
  buildLessWrongUserShortformFeedUrl,
  isLessWrongFrontpage,
  isLessWrongShortformPage,
  isLessWrongUserUrl,
  isLessWrongUrl,
  isLessWrongUserFeedUrl,
  extractUserSlug,
  extractPostId,
  LESSWRONG_FRONTPAGE_FEED_URL,
  LESSWRONG_SHORTFORM_FRONTPAGE_FEED_URL,
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

  // The host index already restricts this plugin to LessWrong hosts, and it
  // handles every LessWrong URL: feed.xml feeds (clean/title), pages (transform
  // to feed), and posts/comments (saved-article fetch). Each capability validates
  // the specific URL shape it cares about, so match all LessWrong URLs here.
  matchUrl(): boolean {
    return true;
  },

  feedBuilderUrl: "https://brendanlong.github.io/lesswrong-rss-builder/",

  capabilities: {
    feed: {
      async transformToFeedUrl(url: URL): Promise<URL | null> {
        const href = url.href;

        // Front page → frontpage feed
        if (isLessWrongFrontpage(href)) {
          logger.info("Detected LessWrong front page", { url: href });
          return new URL(LESSWRONG_FRONTPAGE_FEED_URL);
        }

        // Shortform/quicktakes page → shortform frontpage feed
        if (isLessWrongShortformPage(href)) {
          logger.info("Detected LessWrong shortform page", { url: href });
          return new URL(LESSWRONG_SHORTFORM_FRONTPAGE_FEED_URL);
        }

        // User profile → user posts feed
        if (isLessWrongUserUrl(href)) {
          const slug = extractUserSlug(href);
          if (slug) {
            logger.info("Detected LessWrong user URL", { url: href, slug });
            const user = await fetchLessWrongUserBySlug(slug);
            if (user) {
              logger.info("Using LessWrong user feed", { url: href, user });
              return new URL(buildLessWrongUserFeedUrl(user.userId));
            }
          }
          return null;
        }

        // Post URLs → user shortform feed (if shortform) or post comment feed
        if (isLessWrongUrl(href)) {
          const postId = extractPostId(href);
          if (postId) {
            logger.info("Detected LessWrong post URL", { url: href, postId });
            const metadata = await fetchLessWrongPostMetadata(postId);
            if (metadata?.shortform && metadata.userId) {
              logger.info("LessWrong post is a shortform, using user shortform feed", {
                url: href,
                postId,
                userId: metadata.userId,
              });
              return new URL(buildLessWrongUserShortformFeedUrl(metadata.userId));
            }
            logger.info("Using LessWrong post comment feed", { url: href, postId });
            return new URL(buildLessWrongPostCommentFeedUrl(postId));
          }
        }

        return null;
      },

      cleanEntryContent(html: string): string {
        // Strip "Published on January 7, 2026 2:39 AM GMT<br/><br/>" prefix
        return cleanLessWrongContent(html);
      },

      transformFeedTitle(title: string, feedUrl: URL, context: FeedTitleContext): string {
        // Only user-profile feeds (feed.xml?userId=...) get the author appended.
        // Use the first author from the already-parsed feed entries to avoid an
        // extra GraphQL round-trip during feed processing.
        if (!isLessWrongUserFeedUrl(feedUrl.href)) return title;

        const { firstAuthor } = context;
        if (firstAuthor && !title.includes(firstAuthor)) {
          return `${title} - ${firstAuthor}`;
        }
        return title;
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
