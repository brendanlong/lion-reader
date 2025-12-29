/**
 * Feeds Router
 *
 * Handles feed discovery and preview.
 * Provides endpoints for fetching and parsing feeds without saving them.
 */

import { z } from "zod";

import { createTRPCRouter, publicProcedure } from "../trpc";
import { errors } from "../errors";
import {
  parseFeed,
  discoverFeeds,
  detectFeedType,
  getCommonFeedUrls,
  type ParsedEntry,
  type DiscoveredFeed,
} from "@/server/feed";

// ============================================================================
// Constants
// ============================================================================

/**
 * User-Agent header sent when fetching feeds.
 */
const USER_AGENT = "LionReader/1.0 (+https://lionreader.com/bot)";

/**
 * Timeout for feed fetch requests (10 seconds).
 */
const FETCH_TIMEOUT_MS = 10000;

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
// Validation Schemas
// ============================================================================

/**
 * URL validation schema for feed preview.
 */
const urlSchema = z
  .string()
  .min(1, "URL is required")
  .max(2048, "URL must be less than 2048 characters")
  .url("Invalid URL format")
  .refine((url) => url.startsWith("http://") || url.startsWith("https://"), {
    message: "URL must use http or https protocol",
  });

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
 * Fetches content from a URL with proper error handling.
 *
 * @param url - The URL to fetch
 * @returns The response with text content
 */
async function fetchUrl(url: string): Promise<{ text: string; contentType: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      throw errors.feedFetchError(url, `HTTP ${response.status}`);
    }

    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";

    return { text, contentType };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw errors.feedFetchError(url, "Request timed out");
    }
    if (error instanceof Error && "code" in error) {
      // This is already a TRPCError
      throw error;
    }
    throw errors.feedFetchError(url, error instanceof Error ? error.message : "Unknown error");
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Determines if content is HTML (for feed discovery) or a feed.
 *
 * @param contentType - The content type header
 * @param content - The content body
 * @returns true if the content is HTML
 */
function isHtmlContent(contentType: string, content: string): boolean {
  // Check content type header
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    return true;
  }

  // Fallback: check content itself
  const trimmed = content.trim().toLowerCase();
  return trimmed.startsWith("<!doctype html") || trimmed.startsWith("<html");
}

/**
 * Truncates text to a maximum length, adding ellipsis if needed.
 *
 * @param text - The text to truncate
 * @param maxLength - Maximum length
 * @returns Truncated text
 */
function truncateText(text: string | undefined, maxLength: number): string | null {
  if (!text) {
    return null;
  }

  // Strip HTML tags for summary
  const stripped = text.replace(/<[^>]*>/g, "").trim();

  if (stripped.length <= maxLength) {
    return stripped;
  }

  return stripped.substring(0, maxLength - 3) + "...";
}

/**
 * Transforms a ParsedEntry to a sample entry for the preview response.
 *
 * @param entry - The parsed entry
 * @returns A sample entry object
 */
function toSampleEntry(entry: ParsedEntry): z.infer<typeof sampleEntrySchema> {
  return {
    guid: entry.guid ?? null,
    link: entry.link ?? null,
    title: entry.title ?? null,
    author: entry.author ?? null,
    summary: truncateText(entry.summary ?? entry.content, 300),
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
      const parsed = parseFeed(text);
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
        url: urlSchema,
      })
    )
    .output(
      z.object({
        feed: feedPreviewSchema,
      })
    )
    .query(async ({ input }) => {
      let feedUrl = input.url;

      // Step 1: Fetch the URL
      const { text: content, contentType } = await fetchUrl(feedUrl);

      // Step 2: If HTML, try to discover feeds
      let feedContent: string;
      if (isHtmlContent(contentType, content)) {
        const discoveredFeeds = discoverFeeds(content, feedUrl);

        if (discoveredFeeds.length === 0) {
          throw errors.validation("No feeds found at this URL");
        }

        // Use the first discovered feed
        feedUrl = discoveredFeeds[0].url;

        // Fetch the actual feed
        const feedResult = await fetchUrl(feedUrl);
        feedContent = feedResult.text;
      } else {
        feedContent = content;
      }

      // Step 3: Parse the feed
      let parsedFeed;
      try {
        parsedFeed = parseFeed(feedContent);
      } catch (error) {
        throw errors.parseError(error instanceof Error ? error.message : "Invalid feed format");
      }

      // Step 4: Build and return the preview
      const sampleEntries = parsedFeed.items.slice(0, MAX_SAMPLE_ENTRIES).map(toSampleEntry);

      return {
        feed: {
          url: feedUrl,
          title: parsedFeed.title,
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
        url: urlSchema,
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
      const directFeed = await tryFetchAsFeed(inputUrl, FETCH_TIMEOUT_MS);
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
