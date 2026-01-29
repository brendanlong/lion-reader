/**
 * LessWrong API-based feed fetcher.
 *
 * Fetches posts from the LessWrong GraphQL API for use as a feed type.
 * Supports frontpage, curated, all posts, user posts, and tag posts views.
 *
 * Synthetic URLs use the `lesswrong://` scheme:
 *   - lesswrong://frontpage
 *   - lesswrong://curated
 *   - lesswrong://all
 *   - lesswrong://user/{userId}
 *   - lesswrong://tag/{tagId}
 */

import { z } from "zod";
import { logger } from "@/lib/logger";
import { USER_AGENT } from "@/server/http/user-agent";
import type { ParsedEntry, ParsedFeed } from "./types";

// ============================================================================
// Constants
// ============================================================================

const LESSWRONG_GRAPHQL_ENDPOINT = "https://www.lesswrong.com/graphql";
const GRAPHQL_TIMEOUT_MS = 15000;

/** Default number of posts to fetch per page. */
export const LESSWRONG_FETCH_PAGE_SIZE = 50;

/** Default fetch interval for LessWrong feeds (10 minutes). */
export const LESSWRONG_FETCH_INTERVAL_MS = 10 * 60 * 1000;

// ============================================================================
// Types
// ============================================================================

export type LessWrongView = "frontpage" | "curated" | "all" | "userPosts" | "tagRelevance";

export interface LessWrongFeedConfig {
  view: LessWrongView;
  userId?: string;
  tagId?: string;
}

// ============================================================================
// URL Helpers
// ============================================================================

/**
 * Builds a synthetic `lesswrong://` URL from a feed config.
 */
export function buildLessWrongFeedUrl(config: LessWrongFeedConfig): string {
  switch (config.view) {
    case "frontpage":
      return "lesswrong://frontpage";
    case "curated":
      return "lesswrong://curated";
    case "all":
      return "lesswrong://all";
    case "userPosts":
      if (!config.userId) throw new Error("userId required for userPosts view");
      return `lesswrong://user/${config.userId}`;
    case "tagRelevance":
      if (!config.tagId) throw new Error("tagId required for tagRelevance view");
      return `lesswrong://tag/${config.tagId}`;
  }
}

/**
 * Parses a synthetic `lesswrong://` URL into a feed config.
 * Returns null if the URL is not a valid LessWrong feed URL.
 */
export function parseLessWrongFeedUrl(url: string): LessWrongFeedConfig | null {
  if (!url.startsWith("lesswrong://")) return null;

  const path = url.slice("lesswrong://".length);

  if (path === "frontpage") return { view: "frontpage" };
  if (path === "curated") return { view: "curated" };
  if (path === "all") return { view: "all" };

  const userMatch = path.match(/^user\/(.+)$/);
  if (userMatch) return { view: "userPosts", userId: userMatch[1] };

  const tagMatch = path.match(/^tag\/(.+)$/);
  if (tagMatch) return { view: "tagRelevance", tagId: tagMatch[1] };

  return null;
}

/**
 * Checks if a URL is a LessWrong API feed URL (lesswrong:// scheme).
 */
export function isLessWrongFeedUrl(url: string): boolean {
  return parseLessWrongFeedUrl(url) !== null;
}

/**
 * Returns a human-readable feed title for a LessWrong feed config.
 */
export function getLessWrongFeedTitle(
  config: LessWrongFeedConfig,
  userDisplayName?: string,
  tagName?: string
): string {
  switch (config.view) {
    case "frontpage":
      return "LessWrong - Frontpage";
    case "curated":
      return "LessWrong - Curated";
    case "all":
      return "LessWrong - All Posts";
    case "userPosts":
      return userDisplayName ? `LessWrong - ${userDisplayName}` : "LessWrong - User Posts";
    case "tagRelevance":
      return tagName ? `LessWrong - ${tagName}` : "LessWrong - Tag Posts";
  }
}

// ============================================================================
// GraphQL Queries
// ============================================================================

/**
 * GraphQL query to fetch multiple posts with filtering and pagination.
 * Uses the `posts` resolver which supports view-based filtering.
 */
const POSTS_QUERY = `
  query GetPosts($input: PostsInput!) {
    posts(input: $input) {
      results {
        _id
        title
        slug
        pageUrl
        postedAt
        baseScore
        curatedDate
        user {
          _id
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
      totalCount
    }
  }
`;

const TAG_QUERY = `
  query GetTag($tagId: String!) {
    tag(input: { selector: { _id: $tagId } }) {
      result {
        _id
        name
        slug
      }
    }
  }
`;

// ============================================================================
// Zod Schemas for GraphQL Responses
// ============================================================================

const postResultSchema = z.object({
  _id: z.string(),
  title: z.string().nullable(),
  slug: z.string().nullable(),
  pageUrl: z.string().nullable(),
  postedAt: z.string().nullable(),
  baseScore: z.number().nullable().optional(),
  curatedDate: z.string().nullable().optional(),
  user: z
    .object({
      _id: z.string(),
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
});

const postsResponseSchema = z.object({
  data: z
    .object({
      posts: z
        .object({
          results: z.array(postResultSchema),
          totalCount: z.number().nullable().optional(),
        })
        .nullable(),
    })
    .nullable(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

export type LessWrongPost = z.infer<typeof postResultSchema>;

const tagResponseSchema = z.object({
  data: z
    .object({
      tag: z
        .object({
          result: z
            .object({
              _id: z.string(),
              name: z.string().nullable(),
              slug: z.string().nullable(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

// ============================================================================
// GraphQL Fetching
// ============================================================================

/**
 * Builds the GraphQL input for the posts query based on feed config.
 */
function buildPostsInput(
  config: LessWrongFeedConfig,
  options: { since?: Date; limit?: number; offset?: number }
): Record<string, unknown> {
  const { limit = LESSWRONG_FETCH_PAGE_SIZE, offset = 0 } = options;

  // Base terms for all views
  const terms: Record<string, unknown> = {
    limit,
    offset,
  };

  // Add time filter if we have a cursor
  if (options.since) {
    terms.after = options.since.toISOString();
  }

  switch (config.view) {
    case "frontpage":
      terms.view = "frontpage";
      break;
    case "curated":
      terms.view = "curated";
      break;
    case "all":
      terms.view = "new";
      break;
    case "userPosts":
      terms.view = "userPosts";
      terms.userId = config.userId;
      break;
    case "tagRelevance":
      terms.view = "tagRelevance";
      terms.tagId = config.tagId;
      break;
  }

  return { input: { terms } };
}

/**
 * Fetches posts from the LessWrong GraphQL API.
 */
export async function fetchLessWrongFeedPosts(
  config: LessWrongFeedConfig,
  options: { since?: Date; limit?: number; offset?: number } = {}
): Promise<{ posts: LessWrongPost[]; totalCount: number | null }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GRAPHQL_TIMEOUT_MS);

  try {
    const variables = buildPostsInput(config, options);

    const response = await fetch(LESSWRONG_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: POSTS_QUERY,
        variables,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn("LessWrong feed posts request failed", {
        config,
        status: response.status,
      });
      return { posts: [], totalCount: null };
    }

    const json = await response.json();
    const parsed = postsResponseSchema.safeParse(json);

    if (!parsed.success) {
      logger.warn("LessWrong feed posts response validation failed", {
        config,
        error: parsed.error.message,
      });
      return { posts: [], totalCount: null };
    }

    if (parsed.data.errors && parsed.data.errors.length > 0) {
      logger.warn("LessWrong feed posts GraphQL errors", {
        config,
        errors: parsed.data.errors.map((e) => e.message),
      });
      return { posts: [], totalCount: null };
    }

    const postsData = parsed.data.data?.posts;
    if (!postsData) {
      return { posts: [], totalCount: null };
    }

    return {
      posts: postsData.results,
      totalCount: postsData.totalCount ?? null,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn("LessWrong feed posts request timed out", { config });
    } else {
      logger.warn("LessWrong feed posts request error", {
        config,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { posts: [], totalCount: null };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetches a LessWrong tag by ID.
 */
export async function fetchLessWrongTag(
  tagId: string
): Promise<{ name: string; slug: string } | null> {
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
        query: TAG_QUERY,
        variables: { tagId },
      }),
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const json = await response.json();
    const parsed = tagResponseSchema.safeParse(json);

    if (!parsed.success) return null;

    if (parsed.data.errors && parsed.data.errors.length > 0) return null;

    const tag = parsed.data.data?.tag?.result;
    if (!tag || !tag.name || !tag.slug) return null;

    return { name: tag.name, slug: tag.slug };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// Conversion
// ============================================================================

/**
 * Converts a LessWrong GraphQL post to a ParsedEntry.
 */
export function lessWrongPostToParsedEntry(post: LessWrongPost): ParsedEntry {
  // Build author string
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
    guid: post._id,
    link: post.pageUrl ?? undefined,
    title: post.title ?? undefined,
    author: authors.length > 0 ? authors.join(", ") : undefined,
    content: post.contents?.html ?? undefined,
    pubDate: post.postedAt ? new Date(post.postedAt) : undefined,
  };
}

/**
 * Converts an array of LessWrong posts to a ParsedFeed.
 */
export function lessWrongPostsToParsedFeed(posts: LessWrongPost[], title: string): ParsedFeed {
  return {
    title,
    siteUrl: "https://www.lesswrong.com",
    items: posts.map(lessWrongPostToParsedEntry),
  };
}
