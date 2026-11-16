/**
 * Turning a URL a user gave us into the feed it means: a plugin's page→feed
 * mapping, then the URL itself or the first feed its HTML advertises. Preview
 * and every subscribe-by-URL path resolve through here, so they agree on which
 * feed a URL is.
 */

import { logger } from "@/lib/logger";
import { errors } from "@/server/errors";
import { fetchUrl, HttpFetchError, isHtmlContent } from "@/server/http/fetch";
import { parseFeedAsync } from "@/server/feed/parser";
import { discoverFeeds } from "@/server/feed/discovery";
import type { ParsedFeed } from "@/server/feed/types";
import { getFeedPlugin } from "@/server/plugins";

/**
 * Transforms a page URL into the corresponding feed URL using the matching
 * plugin's `feed.transformToFeedUrl` capability (e.g. a LessWrong front page,
 * user profile, post, or shortform page). Returns null when no plugin handles
 * the URL or it can't be transformed.
 */
export async function transformPageUrlToFeed(url: string): Promise<string | null> {
  const transform = getFeedPlugin(url)?.capabilities.feed.transformToFeedUrl;
  if (!transform) return null;

  try {
    const feedUrl = await transform(new URL(url));
    return feedUrl?.href ?? null;
  } catch (error) {
    // Don't fall through to fetching the page itself: that's a second request
    // to the site that just throttled us
    if (error instanceof HttpFetchError && error.isRateLimited()) {
      throw errors.upstreamRateLimited(url);
    }
    logger.warn("Failed to transform page URL to feed URL", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** The feed a URL resolved to: its final URL (after redirects) and contents. */
export interface ResolvedFeed {
  url: string;
  parsedFeed: ParsedFeed;
}

/**
 * Fetches the feed at a user-supplied URL, which may be a page a plugin maps
 * to its feed or an HTML page advertising one (the first is used).
 *
 * @throws validation if an HTML page advertises no feed, parseError if the
 *   content isn't a feed, or the fetch's own errors
 */
export async function resolveFeedAtUrl(inputUrl: string): Promise<ResolvedFeed> {
  const requestUrl = (await transformPageUrlToFeed(inputUrl)) ?? inputUrl;
  let fetched = await fetchUrl(requestUrl);

  if (isHtmlContent(fetched.contentType, fetched.text)) {
    const discoveredFeeds = discoverFeeds(fetched.text, fetched.finalUrl);
    if (discoveredFeeds.length === 0) {
      throw errors.validation("No feeds found at this URL");
    }
    fetched = await fetchUrl(discoveredFeeds[0].url);
  }

  let parsedFeed: ParsedFeed;
  try {
    parsedFeed = await parseFeedAsync(fetched.text);
  } catch (error) {
    logger.info("URL isn't a parseable feed", {
      url: fetched.finalUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    throw errors.parseError();
  }

  return { url: fetched.finalUrl, parsedFeed };
}
