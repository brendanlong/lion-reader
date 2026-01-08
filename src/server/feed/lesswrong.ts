/**
 * LessWrong content fetcher using the GraphQL API.
 *
 * LessWrong pages are JavaScript-heavy and don't render well with server-side fetching.
 * This module provides direct access to post and comment content via their GraphQL API.
 *
 * Reference: https://www.lesswrong.com/posts/LJiGhpq8w4Badr5KJ/graphql-tutorial-for-lesswrong-and-effective-altruism-forum
 */

import { z } from "zod";
import { logger } from "@/lib/logger";
import { USER_AGENT } from "@/server/http/user-agent";

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
const GRAPHQL_TIMEOUT_MS = 15000;

// ============================================================================
// URL Parsing
// ============================================================================

/**
 * Pattern for matching LessWrong post URLs.
 * Matches: https://www.lesswrong.com/posts/{postId}/{slug}
 *          https://lesswrong.com/posts/{postId}/{slug}
 *
 * The postId is a 17-character alphanumeric ID.
 * Uses a negative lookahead to ensure the ID is exactly 17 characters
 * (not followed by more alphanumeric characters).
 */
const LESSWRONG_POST_URL_PATTERN =
  /^https?:\/\/(?:www\.)?lesswrong\.com\/posts\/([a-zA-Z0-9]{17})(?![a-zA-Z0-9])/;

/**
 * Pattern for matching LessWrong user profile URLs.
 * Matches: https://www.lesswrong.com/users/{slug}
 *          https://lesswrong.com/users/{slug}
 *
 * The slug is the user's URL-friendly username (alphanumeric, hyphens, underscores).
 */
const LESSWRONG_USER_URL_PATTERN =
  /^https?:\/\/(?:www\.)?lesswrong\.com\/users\/([a-zA-Z0-9_-]+)(?:\/|$|\?|#)/;

/**
 * Checks if a URL is a LessWrong post URL.
 */
export function isLessWrongUrl(url: string): boolean {
  return LESSWRONG_POST_URL_PATTERN.test(url);
}

/**
 * Extracts the post ID from a LessWrong URL.
 * Returns null if the URL is not a valid LessWrong post URL.
 */
export function extractPostId(url: string): string | null {
  const match = url.match(LESSWRONG_POST_URL_PATTERN);
  return match ? match[1] : null;
}

/**
 * Extracts the comment ID from a LessWrong URL.
 * Comment URLs have a ?commentId= query parameter.
 * Returns null if there's no comment ID in the URL.
 */
export function extractCommentId(url: string): string | null {
  try {
    const urlObj = new URL(url);
    return urlObj.searchParams.get("commentId");
  } catch {
    return null;
  }
}

/**
 * Checks if a LessWrong URL points to a specific comment.
 */
export function isLessWrongCommentUrl(url: string): boolean {
  return isLessWrongUrl(url) && extractCommentId(url) !== null;
}

/**
 * Checks if a URL is a LessWrong user profile URL.
 */
export function isLessWrongUserUrl(url: string): boolean {
  return LESSWRONG_USER_URL_PATTERN.test(url);
}

/**
 * Extracts the user slug from a LessWrong user profile URL.
 * Returns null if the URL is not a valid LessWrong user profile URL.
 */
export function extractUserSlug(url: string): string | null {
  const match = url.match(LESSWRONG_USER_URL_PATTERN);
  return match ? match[1] : null;
}

// ============================================================================
// GraphQL Types
// ============================================================================

/**
 * Zod schema for the GraphQL response.
 */
const graphqlResponseSchema = z.object({
  data: z
    .object({
      post: z
        .object({
          result: z
            .object({
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
              contents: z
                .object({
                  html: z.string().nullable(),
                })
                .nullable(),
            })
            .nullable(),
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

/**
 * Result from fetching LessWrong post content.
 */
export interface LessWrongPostContent {
  /** Post ID */
  postId: string;
  /** Post title */
  title: string | null;
  /** HTML content of the post */
  html: string;
  /** Author display name */
  author: string | null;
  /** Post publication date */
  publishedAt: Date | null;
  /** Canonical URL */
  url: string | null;
}

/**
 * Zod schema for the comment GraphQL response.
 */
const commentGraphqlResponseSchema = z.object({
  data: z
    .object({
      comment: z
        .object({
          result: z
            .object({
              _id: z.string(),
              postId: z.string().nullable(),
              pageUrl: z.string().nullable(),
              postedAt: z.string().nullable(),
              user: z
                .object({
                  displayName: z.string().nullable(),
                  username: z.string().nullable(),
                })
                .nullable(),
              post: z
                .object({
                  title: z.string().nullable(),
                })
                .nullable(),
              contents: z
                .object({
                  html: z.string().nullable(),
                })
                .nullable(),
            })
            .nullable(),
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

/**
 * Result from fetching LessWrong comment content.
 */
export interface LessWrongCommentContent {
  /** Comment ID */
  commentId: string;
  /** Parent post title (for context) */
  postTitle: string | null;
  /** HTML content of the comment */
  html: string;
  /** Author display name */
  author: string | null;
  /** Comment post date */
  publishedAt: Date | null;
  /** Canonical URL */
  url: string | null;
}

// ============================================================================
// GraphQL Fetching
// ============================================================================

/**
 * GraphQL query to fetch post content.
 * We request the full HTML content via contents.html.
 */
const POST_QUERY = `
  query GetPost($postId: String!) {
    post(input: { selector: { _id: $postId } }) {
      result {
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
        contents {
          html
        }
      }
    }
  }
`;

/**
 * Fetches post content from LessWrong using their GraphQL API.
 *
 * @param postId - The LessWrong post ID (17-character alphanumeric)
 * @returns Post content including HTML, or null if fetch fails
 */
export async function fetchLessWrongPost(postId: string): Promise<LessWrongPostContent | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);

  try {
    const response = await fetch(LESSWRONG_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: POST_QUERY,
        variables: { postId },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("LessWrong GraphQL request failed", {
        postId,
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const json = await response.json();
    const parsed = graphqlResponseSchema.safeParse(json);

    if (!parsed.success) {
      logger.warn("LessWrong GraphQL response validation failed", {
        postId,
        error: parsed.error.message,
      });
      return null;
    }

    // Check for GraphQL errors
    if (parsed.data.errors && parsed.data.errors.length > 0) {
      logger.warn("LessWrong GraphQL returned errors", {
        postId,
        errors: parsed.data.errors.map((e) => e.message),
      });
      return null;
    }

    const post = parsed.data.data?.post?.result;
    if (!post) {
      logger.debug("LessWrong post not found", { postId });
      return null;
    }

    const html = post.contents?.html;
    if (!html) {
      logger.debug("LessWrong post has no content", { postId });
      return null;
    }

    // Build author string from user and coauthors
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

    return {
      postId: post._id,
      title: post.title,
      html,
      author: authors.length > 0 ? authors.join(", ") : null,
      publishedAt: post.postedAt ? new Date(post.postedAt) : null,
      url: post.pageUrl,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("LessWrong GraphQL request timed out", { postId });
    } else {
      logger.warn("LessWrong GraphQL request error", {
        postId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetches LessWrong post content from a URL.
 *
 * This is a convenience function that extracts the post ID from the URL
 * and fetches the content.
 *
 * @param url - The LessWrong post URL
 * @returns Post content including HTML, or null if URL is invalid or fetch fails
 */
export async function fetchLessWrongPostFromUrl(url: string): Promise<LessWrongPostContent | null> {
  const postId = extractPostId(url);
  if (!postId) {
    logger.debug("Not a valid LessWrong post URL", { url });
    return null;
  }

  return fetchLessWrongPost(postId);
}

/**
 * GraphQL query to fetch comment content.
 * We request the full HTML content via contents.html.
 */
const COMMENT_QUERY = `
  query GetComment($commentId: String!) {
    comment(input: { selector: { _id: $commentId } }) {
      result {
        _id
        postId
        pageUrl
        postedAt
        user {
          displayName
          username
        }
        post {
          title
        }
        contents {
          html
        }
      }
    }
  }
`;

/**
 * Fetches comment content from LessWrong using their GraphQL API.
 *
 * @param commentId - The LessWrong comment ID
 * @returns Comment content including HTML, or null if fetch fails
 */
export async function fetchLessWrongComment(
  commentId: string
): Promise<LessWrongCommentContent | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);

  try {
    const response = await fetch(LESSWRONG_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: COMMENT_QUERY,
        variables: { commentId },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("LessWrong GraphQL comment request failed", {
        commentId,
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const json = await response.json();
    const parsed = commentGraphqlResponseSchema.safeParse(json);

    if (!parsed.success) {
      logger.warn("LessWrong GraphQL comment response validation failed", {
        commentId,
        error: parsed.error.message,
      });
      return null;
    }

    // Check for GraphQL errors
    if (parsed.data.errors && parsed.data.errors.length > 0) {
      logger.warn("LessWrong GraphQL comment returned errors", {
        commentId,
        errors: parsed.data.errors.map((e) => e.message),
      });
      return null;
    }

    const comment = parsed.data.data?.comment?.result;
    if (!comment) {
      logger.debug("LessWrong comment not found", { commentId });
      return null;
    }

    const html = comment.contents?.html;
    if (!html) {
      logger.debug("LessWrong comment has no content", { commentId });
      return null;
    }

    // Get author name
    const author = comment.user?.displayName || comment.user?.username || null;

    return {
      commentId: comment._id,
      postTitle: comment.post?.title ?? null,
      html,
      author,
      publishedAt: comment.postedAt ? new Date(comment.postedAt) : null,
      url: comment.pageUrl,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("LessWrong GraphQL comment request timed out", { commentId });
    } else {
      logger.warn("LessWrong GraphQL comment request error", {
        commentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Union type for content fetched from LessWrong.
 */
export type LessWrongContent =
  | (LessWrongPostContent & { type: "post" })
  | (LessWrongCommentContent & { type: "comment" });

/**
 * Fetches LessWrong content from a URL, detecting whether it's a post or comment.
 *
 * This is the main entry point for fetching LessWrong content. It automatically
 * detects whether the URL points to a post or a comment and fetches accordingly.
 *
 * @param url - The LessWrong URL (post or comment)
 * @returns Content including HTML, or null if URL is invalid or fetch fails
 */
export async function fetchLessWrongContentFromUrl(url: string): Promise<LessWrongContent | null> {
  if (!isLessWrongUrl(url)) {
    logger.debug("Not a valid LessWrong URL", { url });
    return null;
  }

  // Check if this is a comment URL
  const commentId = extractCommentId(url);
  if (commentId) {
    logger.debug("Fetching LessWrong comment", { url, commentId });
    const comment = await fetchLessWrongComment(commentId);
    if (comment) {
      return { ...comment, type: "comment" };
    }
    return null;
  }

  // Otherwise, fetch as a post
  const postId = extractPostId(url);
  if (postId) {
    logger.debug("Fetching LessWrong post", { url, postId });
    const post = await fetchLessWrongPost(postId);
    if (post) {
      return { ...post, type: "post" };
    }
  }

  return null;
}

// ============================================================================
// User Lookup
// ============================================================================

/**
 * Zod schema for the user GraphQL response.
 */
const userGraphqlResponseSchema = z.object({
  data: z
    .object({
      user: z
        .object({
          result: z
            .object({
              _id: z.string(),
              displayName: z.string().nullable(),
              slug: z.string().nullable(),
            })
            .nullable(),
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

/**
 * Result from fetching a LessWrong user by slug.
 */
export interface LessWrongUser {
  /** User ID (used for feed URL) */
  userId: string;
  /** User display name */
  displayName: string | null;
  /** User slug (URL-friendly username) */
  slug: string | null;
}

/**
 * GraphQL query to fetch user by slug.
 */
const USER_BY_SLUG_QUERY = `
  query GetUserBySlug($slug: String!) {
    user(input: { selector: { slug: $slug } }) {
      result {
        _id
        displayName
        slug
      }
    }
  }
`;

/**
 * Fetches a LessWrong user by their slug using the GraphQL API.
 *
 * @param slug - The user's URL slug (e.g., "brendan-long")
 * @returns User info including ID, or null if not found
 */
export async function fetchLessWrongUserBySlug(slug: string): Promise<LessWrongUser | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);

  try {
    const response = await fetch(LESSWRONG_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: USER_BY_SLUG_QUERY,
        variables: { slug },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("LessWrong GraphQL user request failed", {
        slug,
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const json = await response.json();
    const parsed = userGraphqlResponseSchema.safeParse(json);

    if (!parsed.success) {
      logger.warn("LessWrong GraphQL user response validation failed", {
        slug,
        error: parsed.error.message,
      });
      return null;
    }

    // Check for GraphQL errors
    if (parsed.data.errors && parsed.data.errors.length > 0) {
      logger.warn("LessWrong GraphQL user returned errors", {
        slug,
        errors: parsed.data.errors.map((e) => e.message),
      });
      return null;
    }

    const user = parsed.data.data?.user?.result;
    if (!user) {
      logger.debug("LessWrong user not found", { slug });
      return null;
    }

    return {
      userId: user._id,
      displayName: user.displayName,
      slug: user.slug,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("LessWrong GraphQL user request timed out", { slug });
    } else {
      logger.warn("LessWrong GraphQL user request error", {
        slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Builds the RSS feed URL for a LessWrong user.
 *
 * @param userId - The user's internal ID
 * @returns The feed URL
 */
export function buildLessWrongUserFeedUrl(userId: string): string {
  return `https://www.lesswrong.com/feed.xml?userId=${encodeURIComponent(userId)}`;
}

/**
 * Checks if a URL is a LessWrong user feed URL (feed.xml with userId param).
 */
export function isLessWrongUserFeedUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    return (
      /^(?:www\.)?lesswrong\.com$/i.test(urlObj.hostname) &&
      urlObj.pathname === "/feed.xml" &&
      urlObj.searchParams.has("userId")
    );
  } catch {
    return false;
  }
}

/**
 * Extracts the userId from a LessWrong user feed URL.
 * Returns null if the URL is not a valid LessWrong user feed URL.
 */
export function extractUserIdFromFeedUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    if (/^(?:www\.)?lesswrong\.com$/i.test(urlObj.hostname) && urlObj.pathname === "/feed.xml") {
      return urlObj.searchParams.get("userId");
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * GraphQL query to fetch user by ID.
 */
const USER_BY_ID_QUERY = `
  query GetUserById($userId: String!) {
    user(input: { selector: { _id: $userId } }) {
      result {
        _id
        displayName
        slug
      }
    }
  }
`;

/**
 * Fetches a LessWrong user by their ID using the GraphQL API.
 *
 * @param userId - The user's internal ID
 * @returns User info, or null if not found
 */
export async function fetchLessWrongUserById(userId: string): Promise<LessWrongUser | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);

  try {
    const response = await fetch(LESSWRONG_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: USER_BY_ID_QUERY,
        variables: { userId },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("LessWrong GraphQL user-by-id request failed", {
        userId,
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const json = await response.json();
    const parsed = userGraphqlResponseSchema.safeParse(json);

    if (!parsed.success) {
      logger.warn("LessWrong GraphQL user-by-id response validation failed", {
        userId,
        error: parsed.error.message,
      });
      return null;
    }

    // Check for GraphQL errors
    if (parsed.data.errors && parsed.data.errors.length > 0) {
      logger.warn("LessWrong GraphQL user-by-id returned errors", {
        userId,
        errors: parsed.data.errors.map((e) => e.message),
      });
      return null;
    }

    const user = parsed.data.data?.user?.result;
    if (!user) {
      logger.debug("LessWrong user not found by id", { userId });
      return null;
    }

    return {
      userId: user._id,
      displayName: user.displayName,
      slug: user.slug,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("LessWrong GraphQL user-by-id request timed out", { userId });
    } else {
      logger.warn("LessWrong GraphQL user-by-id request error", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
