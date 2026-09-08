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
import { HttpFetchError } from "@/server/http/fetch";
import { fetchWithSsrfProtection } from "@/server/http/ssrf";

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
 * Pattern for matching the LessWrong front page.
 * Matches: https://www.lesswrong.com/ or https://www.lesswrong.com
 */
const LESSWRONG_FRONTPAGE_PATTERN = /^https?:\/\/(?:www\.)?lesswrong\.com\/?(?:\?[^/]*)?(?:#.*)?$/;

/**
 * Pattern for matching the LessWrong shortform/quicktakes page.
 * Matches: https://www.lesswrong.com/quicktakes
 */
const LESSWRONG_SHORTFORM_PAGE_PATTERN =
  /^https?:\/\/(?:www\.)?lesswrong\.com\/quicktakes(?:\/|$|\?|#)/;

/**
 * Checks if a URL is a LessWrong post URL.
 */
export function isLessWrongUrl(url: string): boolean {
  return LESSWRONG_POST_URL_PATTERN.test(url);
}

/**
 * Checks if a URL is the LessWrong front page.
 */
export function isLessWrongFrontpage(url: string): boolean {
  return LESSWRONG_FRONTPAGE_PATTERN.test(url);
}

/**
 * Checks if a URL is the LessWrong shortform/quicktakes page.
 */
export function isLessWrongShortformPage(url: string): boolean {
  return LESSWRONG_SHORTFORM_PAGE_PATTERN.test(url);
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
// GraphQL Transport
// ============================================================================

/**
 * The response envelope every GraphQL request comes back in; `data` is validated
 * separately against the caller's schema.
 */
const graphqlEnvelopeSchema = z.object({
  data: z.unknown().nullable(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

/**
 * Sends one query to the LessWrong GraphQL API and returns its validated `data`.
 *
 * Every lookup in this module goes through here so they all share one failure
 * contract:
 *
 * - A non-OK status, an invalid body, GraphQL `errors`, a timeout, or a network
 *   failure logs a warning and returns null.
 * - HTTP 429 **throws** `HttpFetchError` instead. Returning null would let a
 *   caller fall back to fetching the same throttled site, or persist a result
 *   with data missing that's indistinguishable from the data not existing.
 *
 * `endpoint` is a parameter so tests can drive this against a loopback server.
 */
export async function lessWrongGraphql<T extends z.ZodType>(
  request: {
    query: string;
    variables: Record<string, string>;
    dataSchema: T;
    /** Included in every log line for this request (e.g. `{ operation, postId }`). */
    logContext: Record<string, string>;
  },
  endpoint: string = LESSWRONG_GRAPHQL_ENDPOINT
): Promise<z.output<T> | null> {
  const { query, variables, dataSchema, logContext } = request;

  try {
    const response = await fetchWithSsrfProtection(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(GRAPHQL_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn("LessWrong GraphQL request failed", {
        ...logContext,
        status: response.status,
        statusText: response.statusText,
      });
      if (response.status === 429) {
        throw new HttpFetchError(response.status, response.statusText, endpoint);
      }
      return null;
    }

    const envelope = graphqlEnvelopeSchema.safeParse(await response.json());
    if (!envelope.success) {
      logger.warn("LessWrong GraphQL response validation failed", {
        ...logContext,
        error: envelope.error.message,
      });
      return null;
    }

    if (envelope.data.errors && envelope.data.errors.length > 0) {
      logger.warn("LessWrong GraphQL returned errors", {
        ...logContext,
        errors: envelope.data.errors.map((e) => e.message),
      });
      return null;
    }

    if (envelope.data.data == null) {
      return null;
    }

    const data = dataSchema.safeParse(envelope.data.data);
    if (!data.success) {
      logger.warn("LessWrong GraphQL response validation failed", {
        ...logContext,
        error: data.error.message,
      });
      return null;
    }

    return data.data;
  } catch (error) {
    if (error instanceof HttpFetchError) {
      throw error;
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      logger.warn("LessWrong GraphQL request timed out", logContext);
    } else {
      logger.warn("LessWrong GraphQL request error", {
        ...logContext,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

/**
 * The `user` shape LessWrong returns on posts and comments.
 */
const authorSchema = z.object({
  displayName: z.string().nullable(),
  username: z.string().nullable(),
});

/**
 * Picks the name to show for an author: display name, falling back to username.
 */
function authorName(user: z.output<typeof authorSchema> | null | undefined): string | null {
  return user?.displayName || user?.username || null;
}

// ============================================================================
// Post Content
// ============================================================================

const postDataSchema = z.object({
  post: z
    .object({
      result: z
        .object({
          _id: z.string(),
          title: z.string().nullable(),
          slug: z.string().nullable(),
          pageUrl: z.string().nullable(),
          postedAt: z.string().nullable(),
          user: authorSchema.nullable(),
          coauthors: z.array(authorSchema).nullable(),
          contents: z.object({ html: z.string().nullable() }).nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

/**
 * Result from fetching LessWrong post content.
 */
interface LessWrongPostContent {
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
 * @throws HttpFetchError when LessWrong rate limits us (see `lessWrongGraphql`)
 */
async function fetchLessWrongPost(postId: string): Promise<LessWrongPostContent | null> {
  const data = await lessWrongGraphql({
    query: POST_QUERY,
    variables: { postId },
    dataSchema: postDataSchema,
    logContext: { operation: "post", postId },
  });

  const post = data?.post?.result;
  if (!post) {
    logger.debug("LessWrong post not found", { postId });
    return null;
  }

  const html = post.contents?.html;
  if (!html) {
    logger.debug("LessWrong post has no content", { postId });
    return null;
  }

  const authors = [post.user, ...(post.coauthors ?? [])]
    .map(authorName)
    .filter((name): name is string => name !== null);

  return {
    postId: post._id,
    title: post.title,
    html,
    author: authors.length > 0 ? authors.join(", ") : null,
    publishedAt: post.postedAt ? new Date(post.postedAt) : null,
    url: post.pageUrl,
  };
}

// ============================================================================
// Comment Content
// ============================================================================

const commentDataSchema = z.object({
  comment: z
    .object({
      result: z
        .object({
          _id: z.string(),
          postId: z.string().nullable(),
          pageUrl: z.string().nullable(),
          postedAt: z.string().nullable(),
          user: authorSchema.nullable(),
          post: z.object({ title: z.string().nullable() }).nullable(),
          contents: z.object({ html: z.string().nullable() }).nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

/**
 * Result from fetching LessWrong comment content.
 */
interface LessWrongCommentContent {
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
 * @throws HttpFetchError when LessWrong rate limits us (see `lessWrongGraphql`)
 */
async function fetchLessWrongComment(commentId: string): Promise<LessWrongCommentContent | null> {
  const data = await lessWrongGraphql({
    query: COMMENT_QUERY,
    variables: { commentId },
    dataSchema: commentDataSchema,
    logContext: { operation: "comment", commentId },
  });

  const comment = data?.comment?.result;
  if (!comment) {
    logger.debug("LessWrong comment not found", { commentId });
    return null;
  }

  const html = comment.contents?.html;
  if (!html) {
    logger.debug("LessWrong comment has no content", { commentId });
    return null;
  }

  return {
    commentId: comment._id,
    postTitle: comment.post?.title ?? null,
    html,
    author: authorName(comment.user),
    publishedAt: comment.postedAt ? new Date(comment.postedAt) : null,
    url: comment.pageUrl,
  };
}

/**
 * Union type for content fetched from LessWrong.
 */
export type LessWrongContent =
  (LessWrongPostContent & { type: "post" }) | (LessWrongCommentContent & { type: "comment" });

/**
 * Fetches LessWrong content from a URL, detecting whether it's a post or comment.
 *
 * This is the main entry point for fetching LessWrong content. It automatically
 * detects whether the URL points to a post or a comment and fetches accordingly.
 *
 * @param url - The LessWrong URL (post or comment)
 * @returns Content including HTML, or null if URL is invalid or fetch fails
 * @throws HttpFetchError when LessWrong rate limits us (see `lessWrongGraphql`)
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

const userDataSchema = z.object({
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

async function fetchLessWrongUser(
  query: string,
  variables: Record<string, string>,
  logContext: Record<string, string>
): Promise<LessWrongUser | null> {
  const data = await lessWrongGraphql({ query, variables, dataSchema: userDataSchema, logContext });

  const user = data?.user?.result;
  if (!user) {
    logger.debug("LessWrong user not found", logContext);
    return null;
  }

  return {
    userId: user._id,
    displayName: user.displayName,
    slug: user.slug,
  };
}

/**
 * Fetches a LessWrong user by their slug using the GraphQL API.
 *
 * @param slug - The user's URL slug (e.g., "brendan-long")
 * @returns User info including ID, or null if not found
 * @throws HttpFetchError when LessWrong rate limits us (see `lessWrongGraphql`)
 */
export async function fetchLessWrongUserBySlug(slug: string): Promise<LessWrongUser | null> {
  return fetchLessWrongUser(USER_BY_SLUG_QUERY, { slug }, { operation: "userBySlug", slug });
}

/**
 * Fetches a LessWrong user by their ID using the GraphQL API.
 *
 * @param userId - The user's internal ID
 * @returns User info, or null if not found
 * @throws HttpFetchError when LessWrong rate limits us (see `lessWrongGraphql`)
 */
export async function fetchLessWrongUserById(userId: string): Promise<LessWrongUser | null> {
  return fetchLessWrongUser(USER_BY_ID_QUERY, { userId }, { operation: "userById", userId });
}

// ============================================================================
// Feed URLs
// ============================================================================

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
 * The LessWrong frontpage RSS feed URL.
 */
export const LESSWRONG_FRONTPAGE_FEED_URL = "https://www.lesswrong.com/feed.xml?view=frontpage";

/**
 * Builds the RSS feed URL for comments on a specific LessWrong post.
 *
 * @param postId - The LessWrong post ID
 * @returns The comment feed URL
 */
export function buildLessWrongPostCommentFeedUrl(postId: string): string {
  return `https://www.lesswrong.com/feed.xml?type=comments&view=postCommentsNew&postId=${encodeURIComponent(postId)}`;
}

/**
 * The LessWrong shortform frontpage RSS feed URL.
 */
export const LESSWRONG_SHORTFORM_FRONTPAGE_FEED_URL =
  "https://www.lesswrong.com/feed.xml?type=comments&view=shortformFrontpage";

/**
 * Builds the RSS feed URL for a user's shortform posts.
 *
 * @param userId - The user's internal ID
 * @returns The shortform feed URL
 */
export function buildLessWrongUserShortformFeedUrl(userId: string): string {
  return `https://www.lesswrong.com/feed.xml?type=comments&view=shortform&userId=${encodeURIComponent(userId)}`;
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

// ============================================================================
// Post Metadata Lookup (for shortform detection)
// ============================================================================

const postMetadataDataSchema = z.object({
  post: z
    .object({
      result: z
        .object({
          _id: z.string(),
          shortform: z.boolean().nullable(),
          userId: z.string().nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

/**
 * Result from fetching post metadata.
 */
export interface LessWrongPostMetadata {
  /** Post ID */
  postId: string;
  /** Whether this is a shortform post */
  shortform: boolean;
  /** Author's user ID */
  userId: string | null;
}

/**
 * GraphQL query to fetch post metadata (shortform status and author).
 */
const POST_METADATA_QUERY = `
  query GetPostMetadata($postId: String!) {
    post(input: { selector: { _id: $postId } }) {
      result {
        _id
        shortform
        userId
      }
    }
  }
`;

/**
 * Fetches post metadata from LessWrong to determine if it's a shortform post.
 *
 * @param postId - The LessWrong post ID (17-character alphanumeric)
 * @returns Post metadata including shortform status, or null if fetch fails
 * @throws HttpFetchError when LessWrong rate limits us (see `lessWrongGraphql`)
 */
export async function fetchLessWrongPostMetadata(
  postId: string
): Promise<LessWrongPostMetadata | null> {
  const data = await lessWrongGraphql({
    query: POST_METADATA_QUERY,
    variables: { postId },
    dataSchema: postMetadataDataSchema,
    logContext: { operation: "postMetadata", postId },
  });

  const post = data?.post?.result;
  if (!post) {
    logger.debug("LessWrong post not found for metadata", { postId });
    return null;
  }

  return {
    postId: post._id,
    shortform: post.shortform ?? false,
    userId: post.userId,
  };
}
