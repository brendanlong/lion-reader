/**
 * LessWrong feed fetcher using the GraphQL API.
 *
 * LessWrong's RSS feed is limited - it uses the post content with a "Published on..."
 * prefix and doesn't include the social preview text. This module fetches posts
 * directly via GraphQL to get richer metadata including:
 * - socialPreviewData.text - the social share description (better summary)
 * - Clean HTML content without the date prefix
 * - Author information including coauthors
 *
 * When a user subscribes to https://www.lesswrong.com/feed.xml, we transparently
 * use this GraphQL fetcher instead of the RSS feed.
 */

import { z } from "zod";
import { logger } from "@/lib/logger";
import type { ParsedFeed, ParsedEntry } from "./types";

// ============================================================================
// Constants
// ============================================================================

/**
 * LessWrong GraphQL API endpoint.
 */
const LESSWRONG_GRAPHQL_ENDPOINT = "https://www.lesswrong.com/graphql";

/**
 * Timeout for GraphQL requests in milliseconds.
 */
const GRAPHQL_TIMEOUT_MS = 30000;

/**
 * User-Agent for requests.
 */
const USER_AGENT = "LionReader/1.0 (+https://lionreader.com)";

/**
 * Number of posts to fetch per request.
 * LessWrong's RSS feed typically contains around 20-30 posts.
 */
const POSTS_LIMIT = 30;

// ============================================================================
// URL Detection
// ============================================================================

/**
 * Known LessWrong feed URLs that should use the GraphQL fetcher.
 * These are the standard RSS/Atom feed URLs that LessWrong provides.
 */
const LESSWRONG_FEED_PATTERNS = [
  /^https?:\/\/(?:www\.)?lesswrong\.com\/feed\.xml$/,
  /^https?:\/\/(?:www\.)?lesswrong\.com\/feed$/,
  /^https?:\/\/(?:www\.)?lesswrong\.com\/rss\.xml$/,
] as const;

/**
 * Checks if a feed URL is a LessWrong main feed that should use GraphQL fetching.
 *
 * @param url - The feed URL to check
 * @returns True if this feed should use the GraphQL fetcher
 */
export function isLessWrongFeedUrl(url: string): boolean {
  return LESSWRONG_FEED_PATTERNS.some((pattern) => pattern.test(url));
}

// ============================================================================
// GraphQL Types
// ============================================================================

/**
 * Zod schema for the posts GraphQL response.
 */
const postsGraphqlResponseSchema = z.object({
  data: z
    .object({
      posts: z
        .object({
          results: z.array(
            z.object({
              _id: z.string(),
              title: z.string().nullable(),
              slug: z.string().nullable(),
              pageUrl: z.string().nullable(),
              postedAt: z.string().nullable(),
              user: z
                .object({
                  displayName: z.string().nullable(),
                  username: z.string().nullable(),
                })
                .nullable(),
              coauthors: z
                .array(
                  z.object({
                    displayName: z.string().nullable(),
                    username: z.string().nullable(),
                  })
                )
                .nullable(),
              socialPreviewData: z
                .object({
                  text: z.string().nullable(),
                  imageUrl: z.string().nullable(),
                })
                .nullable(),
              contents: z
                .object({
                  html: z.string().nullable(),
                })
                .nullable(),
            })
          ),
        })
        .nullable(),
    })
    .nullable(),
  errors: z
    .array(
      z.object({
        message: z.string(),
      })
    )
    .optional(),
});

type PostsGraphqlResponse = z.infer<typeof postsGraphqlResponseSchema>;
type LessWrongPost = NonNullable<
  NonNullable<NonNullable<PostsGraphqlResponse["data"]>["posts"]>["results"]
>[number];

// ============================================================================
// GraphQL Query
// ============================================================================

/**
 * GraphQL query to fetch recent posts.
 * We request fields that give us richer data than the RSS feed.
 */
const POSTS_QUERY = `
  query GetRecentPosts($limit: Int!) {
    posts(input: { terms: { view: "new", limit: $limit } }) {
      results {
        _id
        title
        slug
        pageUrl
        postedAt
        user {
          displayName
          username
        }
        coauthors {
          displayName
          username
        }
        socialPreviewData {
          text
          imageUrl
        }
        contents {
          html
        }
      }
    }
  }
`;

// ============================================================================
// Feed Fetching
// ============================================================================

/**
 * Builds an author string from user and coauthors.
 */
function buildAuthorString(post: LessWrongPost): string | undefined {
  const authors: string[] = [];

  if (post.user?.displayName) {
    authors.push(post.user.displayName);
  } else if (post.user?.username) {
    authors.push(post.user.username);
  }

  if (post.coauthors) {
    for (const coauthor of post.coauthors) {
      if (coauthor.displayName) {
        authors.push(coauthor.displayName);
      } else if (coauthor.username) {
        authors.push(coauthor.username);
      }
    }
  }

  return authors.length > 0 ? authors.join(", ") : undefined;
}

/**
 * Converts a LessWrong post to a ParsedEntry.
 */
function postToParsedEntry(post: LessWrongPost): ParsedEntry {
  return {
    guid: post._id,
    link: post.pageUrl ?? undefined,
    title: post.title ?? undefined,
    author: buildAuthorString(post),
    content: post.contents?.html ?? undefined,
    // Use the social preview text as the summary - this is much better than
    // extracting from the content since it's specifically written for sharing
    summary: post.socialPreviewData?.text ?? undefined,
    pubDate: post.postedAt ? new Date(post.postedAt) : undefined,
  };
}

/**
 * Fetches the LessWrong feed using the GraphQL API.
 *
 * This returns a ParsedFeed that can be processed by the standard entry processor,
 * but with enhanced data compared to the RSS feed:
 * - socialPreviewData.text is used as the summary (better than content extraction)
 * - Clean HTML content without the "Published on..." prefix
 * - Coauthors included in the author field
 *
 * @returns ParsedFeed with LessWrong posts, or null if fetch fails
 */
export async function fetchLessWrongFeed(): Promise<ParsedFeed | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);

  try {
    logger.debug("Fetching LessWrong feed via GraphQL");

    const response = await fetch(LESSWRONG_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: POSTS_QUERY,
        variables: { limit: POSTS_LIMIT },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("LessWrong GraphQL posts request failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const json = await response.json();
    const parsed = postsGraphqlResponseSchema.safeParse(json);

    if (!parsed.success) {
      logger.warn("LessWrong GraphQL posts response validation failed", {
        error: parsed.error.message,
      });
      return null;
    }

    // Check for GraphQL errors
    if (parsed.data.errors && parsed.data.errors.length > 0) {
      logger.warn("LessWrong GraphQL posts returned errors", {
        errors: parsed.data.errors.map((e) => e.message),
      });
      return null;
    }

    const posts = parsed.data.data?.posts?.results;
    if (!posts || posts.length === 0) {
      logger.debug("LessWrong GraphQL returned no posts");
      return null;
    }

    // Convert posts to ParsedFeed format
    const items: ParsedEntry[] = posts.map(postToParsedEntry);

    logger.info("Fetched LessWrong feed via GraphQL", {
      postCount: items.length,
    });

    return {
      title: "LessWrong",
      description: "A community blog devoted to refining the art of rationality",
      siteUrl: "https://www.lesswrong.com",
      items,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("LessWrong GraphQL posts request timed out");
    } else {
      logger.warn("LessWrong GraphQL posts request error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
