/**
 * Feeds Router
 *
 * Handles feed discovery and preview.
 * Provides endpoints for fetching and parsing feeds without saving them.
 */

import { z } from "zod";

import { logger } from "@/lib/logger";
import { createTRPCRouter, publicProcedure } from "../trpc";
import { errors } from "../errors";
import { feedUrlSchema } from "../validation";
import { fetchUrl, isHtmlContent, FEED_FETCH_TIMEOUT_MS } from "@/server/http/fetch";
import { stripHtml } from "@/server/html/strip-html";
import { USER_AGENT } from "@/server/http/user-agent";
import {
  parseFeed,
  discoverFeeds,
  detectFeedType,
  getCommonFeedUrls,
  getDomainFromUrl,
  type ParsedEntry,
  type DiscoveredFeed,
} from "@/server/feed";
import { isLessWrongFeed, cleanLessWrongContent } from "@/server/feed/content-cleaner";
import {
  isLessWrongUserUrl,
  isLessWrongUserFeedUrl,
  extractUserSlug,
  fetchLessWrongUserBySlug,
  buildLessWrongUserFeedUrl,
} from "@/server/feed/lesswrong";

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of sample entries to return in preview.
 */
const MAX_SAMPLE_ENTRIES = 5;

/**
 * Timeout for checking common paths during discovery (5 seconds per path).
 */
const DISCOVERY_PATH_TIMEOUT_MS = 5000;

/**
 * Maximum number of common paths to check concurrently.
 */
const MAX_CONCURRENT_PATH_CHECKS = 5;

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Sample entry schema for preview.
 */
const sampleEntrySchema = z.object({
  guid: z.string().nullable(),
  link: z.string().nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  summary: z.string().nullable(),
  pubDate: z.date().nullable(),
});

/**
 * Feed preview output schema.
 */
const feedPreviewSchema = z.object({
  url: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  siteUrl: z.string().nullable(),
  iconUrl: z.string().nullable(),
  sampleEntries: z.array(sampleEntrySchema),
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Truncates text to a maximum length, adding ellipsis if needed.
 * Uses SAX parsing to strip HTML tags.
 *
 * @param text - The text to truncate (may contain HTML)
 * @param maxLength - Maximum length
 * @returns Truncated plain text
 */
function truncateText(text: string | undefined, maxLength: number): string | null {
  if (!text) {
    return null;
  }

  const stripped = stripHtml(text, maxLength);

  if (stripped.length <= maxLength) {
    return stripped;
  }

  return stripped.substring(0, maxLength - 3) + "...";
}

/**
 * Transforms a ParsedEntry to a sample entry for the preview response.
 *
 * Applies feed-specific cleaning (e.g., stripping LessWrong's "Published on..." prefix)
 * before generating the summary.
 *
 * @param entry - The parsed entry
 * @param feedUrl - The feed URL (for feed-specific cleaning)
 * @returns A sample entry object
 */
function toSampleEntry(entry: ParsedEntry, feedUrl: string): z.infer<typeof sampleEntrySchema> {
  // Get the content to use for summary
  let content = entry.summary ?? entry.content;

  // Apply feed-specific cleaning
  if (content && isLessWrongFeed(feedUrl)) {
    content = cleanLessWrongContent(content);
  }

  return {
    guid: entry.guid ?? null,
    link: entry.link ?? null,
    title: entry.title ?? null,
    author: entry.author ?? null,
    summary: truncateText(content, 300),
    pubDate: entry.pubDate ?? null,
  };
}

/**
 * Tries to fetch a URL and determine if it's a valid feed.
 * Returns the discovered feed info if it is, or null if not.
 *
 * @param url - The URL to check
 * @param timeoutMs - Timeout for the fetch request
 * @returns DiscoveredFeed if valid feed, null otherwise
 */
async function tryFetchAsFeed(
  url: string,
  timeoutMs: number = DISCOVERY_PATH_TIMEOUT_MS
): Promise<DiscoveredFeed | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml, */*",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    const feedType = detectFeedType(text);

    if (feedType === "unknown") {
      return null;
    }

    // Try to parse to get the title
    try {
      const parsed = await parseFeed(text);
      return {
        url,
        type: feedType,
        title: parsed.title || undefined,
      };
    } catch {
      // Could detect type but couldn't parse - still return it
      return {
        url,
        type: feedType,
        title: undefined,
      };
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Checks common feed paths on a domain concurrently.
 * Returns all discovered feeds.
 *
 * @param baseUrl - The base URL to check paths from
 * @returns Array of discovered feeds from common paths
 */
async function checkCommonPaths(baseUrl: string): Promise<DiscoveredFeed[]> {
  const pathUrls = getCommonFeedUrls(baseUrl);
  const discovered: DiscoveredFeed[] = [];

  // Process in batches to limit concurrency
  for (let i = 0; i < pathUrls.length; i += MAX_CONCURRENT_PATH_CHECKS) {
    const batch = pathUrls.slice(i, i + MAX_CONCURRENT_PATH_CHECKS);
    const results = await Promise.all(batch.map((url) => tryFetchAsFeed(url)));

    for (const result of results) {
      if (result) {
        discovered.push(result);
      }
    }

    // If we found feeds, we can stop checking more paths
    if (discovered.length > 0) {
      break;
    }
  }

  return discovered;
}

/**
 * Output schema for discovered feed.
 */
const discoveredFeedSchema = z.object({
  url: z.string(),
  type: z.enum(["rss", "atom", "json", "unknown"]),
  title: z.string().optional(),
});

// ============================================================================
// Router
// ============================================================================

export const feedsRouter = createTRPCRouter({
  /**
   * Preview a feed by URL.
   *
   * This procedure:
   * 1. Fetches the URL content
   * 2. If HTML, discovers feeds and uses the first one
   * 3. Parses the feed to get metadata and sample entries
   * 4. Returns the preview without saving anything to the database
   *
   * This is a public procedure - no authentication required.
   * It allows users to preview a feed before subscribing.
   *
   * @param url - The feed URL (or HTML page with feed discovery)
   * @returns Feed preview with title, description, and sample entries
   */
  preview: publicProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/feeds/preview",
        tags: ["Feeds"],
        summary: "Preview a feed without subscribing",
      },
    })
    .input(
      z.object({
        url: feedUrlSchema,
      })
    )
    .output(
      z.object({
        feed: feedPreviewSchema,
      })
    )
    .query(async ({ input }) => {
      let feedUrl = input.url;

      // Special case: LessWrong user profile pages
      // Look up the user via GraphQL API to get their feed URL
      if (isLessWrongUserUrl(feedUrl)) {
        const slug = extractUserSlug(feedUrl);
        if (slug) {
          logger.info("Preview: Detected LessWrong user URL", { feedUrl, slug });
          const user = await fetchLessWrongUserBySlug(slug);
          if (user) {
            feedUrl = buildLessWrongUserFeedUrl(user.userId);
            logger.info("Preview: Using LessWrong user feed", { feedUrl, user });
          }
        }
      }

      // Step 1: Fetch the URL
      const { text: content, contentType, finalUrl: initialFinalUrl } = await fetchUrl(feedUrl);

      // Step 2: If HTML, try to discover feeds
      let feedContent: string;
      let finalFeedUrl: string;
      if (isHtmlContent(contentType, content)) {
        const discoveredFeeds = discoverFeeds(content, initialFinalUrl);

        if (discoveredFeeds.length === 0) {
          throw errors.validation("No feeds found at this URL");
        }

        // Use the first discovered feed
        feedUrl = discoveredFeeds[0].url;

        // Fetch the actual feed
        const feedResult = await fetchUrl(feedUrl);
        feedContent = feedResult.text;
        finalFeedUrl = feedResult.finalUrl;
      } else {
        feedContent = content;
        finalFeedUrl = initialFinalUrl;
      }

      // Step 3: Parse the feed
      let parsedFeed;
      try {
        parsedFeed = await parseFeed(feedContent);
      } catch (error) {
        throw errors.parseError(error instanceof Error ? error.message : "Invalid feed format");
      }

      // Step 4: Build and return the preview
      // Sort entries by publication date (newest first) before taking sample
      // Entries without dates are placed last
      const sortedItems = [...parsedFeed.items].sort((a, b) => {
        if (!a.pubDate && !b.pubDate) return 0;
        if (!a.pubDate) return 1;
        if (!b.pubDate) return -1;
        return b.pubDate.getTime() - a.pubDate.getTime();
      });

      const sampleEntries = sortedItems
        .slice(0, MAX_SAMPLE_ENTRIES)
        .map((entry) => toSampleEntry(entry, finalFeedUrl));

      // Use domain as fallback if feed has no title
      const fallbackTitle = getDomainFromUrl(finalFeedUrl) ?? "Untitled Feed";
      let feedTitle = parsedFeed.title ?? fallbackTitle;

      // For LessWrong user feeds, append the author name if not already in the title
      if (isLessWrongUserFeedUrl(finalFeedUrl)) {
        const firstAuthor = parsedFeed.items.find((item) => item.author)?.author;
        if (firstAuthor && !feedTitle.includes(firstAuthor)) {
          feedTitle = `${feedTitle} - ${firstAuthor}`;
        }
      }

      return {
        feed: {
          url: finalFeedUrl,
          title: feedTitle,
          description: parsedFeed.description ?? null,
          siteUrl: parsedFeed.siteUrl ?? null,
          iconUrl: parsedFeed.iconUrl ?? null,
          sampleEntries,
        },
      };
    }),

  /**
   * Discover feeds from a URL.
   *
   * This procedure:
   * 1. First tries to parse the URL as a feed directly
   * 2. If not a feed, fetches the page and looks for <link rel="alternate"> tags
   * 3. Also checks common feed paths on the same domain
   * 4. Returns all discovered feeds with title, type, and URL
   * 5. Deduplicates by URL
   *
   * This is a public procedure - no authentication required.
   * It allows users to discover feeds before subscribing.
   *
   * @param url - The URL to discover feeds from
   * @returns Array of discovered feeds
   */
  discover: publicProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/feeds/discover",
        tags: ["Feeds"],
        summary: "Discover feeds from a URL",
      },
    })
    .input(
      z.object({
        url: feedUrlSchema,
      })
    )
    .output(
      z.object({
        feeds: z.array(discoveredFeedSchema),
      })
    )
    .query(async ({ input }) => {
      const inputUrl = input.url;
      const seenUrls = new Set<string>();
      const allFeeds: DiscoveredFeed[] = [];

      /**
       * Helper to add a feed to results, deduplicating by URL.
       */
      function addFeed(feed: DiscoveredFeed): void {
        if (!seenUrls.has(feed.url)) {
          seenUrls.add(feed.url);
          allFeeds.push(feed);
        }
      }

      // Step 1: Try to fetch and parse the URL as a feed directly
      const directFeed = await tryFetchAsFeed(inputUrl, FEED_FETCH_TIMEOUT_MS);
      if (directFeed) {
        addFeed(directFeed);
        // If it's a valid feed, return it directly (no need to check other sources)
        return { feeds: allFeeds };
      }

      // Step 2: Fetch the URL and try to discover feeds from HTML
      try {
        const { text: content, contentType } = await fetchUrl(inputUrl);

        if (isHtmlContent(contentType, content)) {
          // Look for <link rel="alternate"> tags in the HTML
          const htmlFeeds = discoverFeeds(content, inputUrl);
          for (const feed of htmlFeeds) {
            addFeed(feed);
          }
        }
      } catch {
        // If we can't fetch the page, we'll just check common paths
      }

      // Step 3: Check common feed paths on the domain
      // Only do this if we haven't found any feeds yet
      if (allFeeds.length === 0) {
        const pathFeeds = await checkCommonPaths(inputUrl);
        for (const feed of pathFeeds) {
          addFeed(feed);
        }
      }

      return { feeds: allFeeds };
    }),
});
