/**
 * Plugin system for Lion Reader
 *
 * Consolidates custom parsing logic for feeds, entries, and saved articles.
 * Plugins are registered at module load time and provide capabilities for different use cases.
 */

import { pluginRegistry } from "./registry";
import { lessWrongPlugin } from "./lesswrong";
import { googleDocsPlugin } from "./google-docs";
import { arxivPlugin } from "./arxiv";
import { githubPlugin } from "./github";
import { youtubePlugin } from "./youtube";
import { blueskyPlugin } from "./bluesky";
import { linkedInPlugin } from "./linkedin";
import { threadsPlugin } from "./threads";
import { notionPlugin } from "./notion";
import type { FetchedPage, PluginWith, SavedArticleContent } from "./types";
import type { ParsedEntry } from "@/server/feed/types";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import {
  ContentTooLargeError,
  fetchHtmlPage,
  HttpFetchError,
  type FetchHtmlPageResult,
} from "@/server/http/fetch";
import { getAppErrorCode } from "@/server/trpc/errors";

// Register all available plugins at module load time
const plugins = [
  lessWrongPlugin,
  googleDocsPlugin,
  arxivPlugin,
  githubPlugin,
  youtubePlugin,
  blueskyPlugin,
  linkedInPlugin,
  threadsPlugin,
  notionPlugin,
];
for (const plugin of plugins) pluginRegistry.register(plugin);
logger.info("Plugins registered", {
  plugins: pluginRegistry.plugins.map((plugin) => plugin.name),
});

/**
 * Offer a page the generic fetch already retrieved to the plugins that can
 * recognize their source from the page itself (`fetchContentFromPage`), for
 * URLs no hostname lookup claimed. Returns the first plugin's content, or null
 * when none claims it. A plugin failure is logged and counts as "not claimed":
 * the caller keeps the page it already has.
 */
export async function claimFetchedPage(
  page: FetchedPage
): Promise<{ plugin: PluginWith<"savedArticle">; content: SavedArticleContent } | null> {
  for (const plugin of pluginRegistry.fetchedPageHandlers) {
    const fetchContentFromPage = plugin.capabilities.savedArticle.fetchContentFromPage;
    if (!fetchContentFromPage) continue;
    try {
      const content = await fetchContentFromPage(page);
      if (content) return { plugin, content };
    } catch (error) {
      logger.warn("Plugin failed on a fetched page, keeping the page as fetched", {
        plugin: plugin.name,
        url: page.url.href,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return null;
}

/** Article content a plugin (or another source-specific fetcher) produced. */
export interface PluginArticle {
  kind: "plugin";
  /** Plugin name, for logs. */
  source: string;
  content: SavedArticleContent;
  skipReadability?: boolean;
  siteName?: string;
  /** Resolves relative URLs when the content has no `canonicalUrl`. */
  baseUrl: string;
}

export type AcquiredArticle = PluginArticle | ({ kind: "page" } & FetchHtmlPageResult);

export interface AcquireArticleOptions {
  /** URL for the generic page fetch, when it differs from `url`. */
  pageUrl?: string;
  /** Tried after the hostname-matched plugin declines, before the generic fetch. */
  beforePageFetch?: () => Promise<PluginArticle | null>;
}

/**
 * Fetches an article for a save or a full-content fetch: the hostname-matched
 * plugin, then `beforePageFetch`, then the generic page fetch, whose result is
 * offered to {@link claimFetchedPage} unless it is Markdown. Content is capped
 * at `maxSavedArticleSizeBytes` on every path.
 *
 * A plugin failure falls back to the generic fetch, except a rate limit (the
 * same site would rate limit that too) and a size-limit breach, which are
 * rethrown. Generic fetch errors propagate for the caller to classify.
 */
export async function acquireArticleContent(
  url: string,
  options: AcquireArticleOptions = {}
): Promise<AcquiredArticle> {
  const maxSize = usageLimitsConfig.maxSavedArticleSizeBytes;
  const assertWithinLimit = (article: PluginArticle): PluginArticle => {
    if (article.content.html.length > maxSize) {
      throw new ContentTooLargeError(url, maxSize, article.content.html.length);
    }
    return article;
  };

  const parsed = toUrl(url);
  const plugin = parsed ? pluginRegistry.findWithCapability(parsed, "savedArticle") : null;
  if (plugin && parsed) {
    const capability = plugin.capabilities.savedArticle;
    try {
      const content = await capability.fetchContent(parsed);
      if (content) {
        logger.debug("Plugin fetched the article", { url, plugin: plugin.name });
        return assertWithinLimit(pluginArticle(plugin, content, url));
      }
    } catch (error) {
      if (
        (error instanceof HttpFetchError && error.isRateLimited()) ||
        error instanceof ContentTooLargeError ||
        getAppErrorCode(error) === "CONTENT_TOO_LARGE"
      ) {
        throw error;
      }
      logger.warn("Plugin fetch failed, falling back to normal fetch", {
        url,
        plugin: plugin.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const fromSource = await options.beforePageFetch?.();
  if (fromSource) return assertWithinLimit(fromSource);

  const page = await fetchHtmlPage(options.pageUrl ?? url);
  if (plugin || page.isMarkdown) return { kind: "page", ...page };

  const claimed = await claimFetchedPage({ html: page.content, url: new URL(page.finalUrl) });
  if (!claimed) return { kind: "page", ...page };
  if (claimed.content.html.length > maxSize) {
    // Unlike the hostname-matched path, a claimed page has a fallback in hand.
    logger.warn("Plugin content for the fetched page is too large, keeping the page as fetched", {
      url: page.finalUrl,
      plugin: claimed.plugin.name,
    });
    return { kind: "page", ...page };
  }
  logger.debug("Plugin claimed the fetched page", { url, plugin: claimed.plugin.name });
  return pluginArticle(claimed.plugin, claimed.content, page.finalUrl);
}

function pluginArticle(
  plugin: PluginWith<"savedArticle">,
  content: SavedArticleContent,
  baseUrl: string
): PluginArticle {
  const { skipReadability, siteName } = plugin.capabilities.savedArticle;
  return { kind: "plugin", source: plugin.name, content, skipReadability, siteName, baseUrl };
}

/** Parses a feed/page URL, or returns null if it's missing or invalid. */
function toUrl(url: string | URL | null | undefined): URL | null {
  if (!url) return null;
  try {
    return url instanceof URL ? url : new URL(url);
  } catch {
    return null;
  }
}

/**
 * Resolve the feed-capable plugin for a feed or page URL string.
 *
 * Returns the matching plugin (with its `feed` capability) or null if the URL is
 * invalid or no plugin handles it. Use this at feed-processing call sites so
 * feed-source customization lives in plugins rather than hardcoded branches.
 */
export function getFeedPlugin(url: string | URL | null | undefined) {
  const parsed = toUrl(url);
  return parsed ? pluginRegistry.findWithCapability(parsed, "feed") : null;
}

/**
 * The synchronous feed-processing hooks of the plugin matching a feed URL,
 * each falling back to "no plugin" behavior (and logging) when the plugin
 * throws, so a broken hook can't fail a fetch, preview or subscribe. Without a
 * matching plugin every hook is a no-op.
 */
export interface FeedHooks {
  /** `items` are the feed's parsed entries, which the plugin may draw on. */
  transformFeedTitle(title: string, items: readonly ParsedEntry[]): string;
  /** Returns `html` unchanged when there's nothing to clean. */
  cleanEntryContent(html: string): string;
  buildEntryContent(entry: ParsedEntry, entryUrl: string | undefined): string | null;
}

export function getFeedHooks(feedUrl: string | URL | null | undefined): FeedHooks {
  const parsed = toUrl(feedUrl);
  const plugin = parsed ? pluginRegistry.findWithCapability(parsed, "feed") : null;
  const feed = plugin?.capabilities.feed;

  function guarded<A extends unknown[], R>(
    hook: string,
    fn: ((...args: A) => R) | undefined,
    fallback: (...args: A) => R
  ): (...args: A) => R {
    if (!fn || !plugin) return fallback;
    return (...args) => {
      try {
        return fn(...args);
      } catch (error) {
        logger.warn("Plugin feed hook threw; using the unplugged result", {
          plugin: plugin.name,
          hook,
          feedUrl: parsed?.href,
          error: error instanceof Error ? error.message : String(error),
        });
        return fallback(...args);
      }
    };
  }

  const transformFeedTitle = feed?.transformFeedTitle?.bind(feed);
  return {
    transformFeedTitle: guarded(
      "transformFeedTitle",
      transformFeedTitle && parsed
        ? (title: string, items: readonly ParsedEntry[]) =>
            transformFeedTitle(title, parsed, {
              firstAuthor: items.find((item) => item.author)?.author ?? null,
            })
        : undefined,
      (title) => title
    ),
    cleanEntryContent: guarded(
      "cleanEntryContent",
      feed?.cleanEntryContent?.bind(feed),
      (html) => html
    ),
    buildEntryContent: guarded<[ParsedEntry, string | undefined], string | null>(
      "buildEntryContent",
      feed?.buildEntryContent?.bind(feed),
      () => null
    ),
  };
}

/**
 * Whether new subscriptions to this feed URL should default `fetch_full_content`
 * on (a plugin opt-in for sources whose feed entries are truncated or drop
 * embedded content, e.g. Bluesky). Returns false for an invalid/unhandled URL.
 */
export function feedDefaultsToFullContent(url: string | URL | null | undefined): boolean {
  const parsed = toUrl(url);
  return parsed ? pluginRegistry.feedDefaultsToFullContent(parsed) : false;
}

// Export registry and types
export { pluginRegistry } from "./registry";
export type * from "./types";
