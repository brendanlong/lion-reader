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
import { threadReaderPlugin } from "./threadreader";
import { notionPlugin } from "./notion";
import { substackPlugin } from "./substack";
import type {
  FetchedPage,
  PluginWith,
  SavedArticleContent,
  SavedArticlePdf,
  UserFetchContext,
} from "./types";
import type { ParsedEntry } from "@/server/feed/types";
import { logger } from "@/lib/logger";
import { usageLimitsConfig } from "@/server/config/env";
import {
  ContentTooLargeError,
  fetchArticle,
  HttpFetchError,
  type FetchHtmlPageResult,
} from "@/server/http/fetch";
import { getAppErrorCode } from "@/server/errors";

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
  threadReaderPlugin,
  notionPlugin,
  substackPlugin,
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

/** Article content a plugin produced. */
interface PluginArticle {
  kind: "plugin";
  /** Plugin name, for logs. */
  source: string;
  content: SavedArticleContent;
  skipReadability?: boolean;
  siteName?: string;
  /** Resolves relative URLs when the content has no `canonicalUrl`. */
  baseUrl: string;
}

/** A PDF, fetched generically or by a plugin. */
interface FetchedPdf {
  kind: "pdf";
  pdf: Buffer;
  finalUrl: string;
  /** Set when a plugin fetched it: metadata preferred over the PDF's own. */
  plugin?: Omit<SavedArticlePdf, "pdf" | "finalUrl"> & { siteName?: string };
}

export type AcquiredArticle = PluginArticle | ({ kind: "page" } & FetchHtmlPageResult) | FetchedPdf;

export interface AcquireArticleOptions {
  /** The saving user, for plugins that can fetch with their credentials. */
  asUser?: UserFetchContext;
}

/**
 * Wraps whatever a plugin's `fetchContentAsUser` threw: a failure already
 * worded for the user (a consent prompt) or our bug, never a problem with the
 * URL, so callers rethrow `cause` instead of classifying it as a fetch error.
 */
export class UserFetchError extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "UserFetchError";
  }
}

/**
 * Fetches an article for a save or a full-content fetch: the hostname-matched
 * plugin, then (given `asUser`) its `fetchContentAsUser`, then the generic page
 * fetch, whose result is offered to {@link claimFetchedPage} unless it is
 * Markdown or a PDF. Content is capped at `maxSavedArticleSizeBytes` on every path.
 *
 * A plugin failure falls back to the generic fetch, except a rate limit (the
 * same site would rate limit that too) and a size-limit breach, which are
 * rethrown, and a `fetchContentAsUser` failure, thrown as a
 * {@link UserFetchError}. Generic fetch errors propagate for the caller to
 * classify.
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
        if ("pdf" in content) {
          const { pdf, finalUrl, ...metadata } = content;
          const { siteName } = capability;
          return { kind: "pdf", pdf, finalUrl, plugin: { ...metadata, siteName } };
        }
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

    if (options.asUser && capability.fetchContentAsUser) {
      let content: SavedArticleContent | null;
      try {
        content = await capability.fetchContentAsUser(parsed, options.asUser);
      } catch (error) {
        throw new UserFetchError(error);
      }
      if (content) return assertWithinLimit(pluginArticle(plugin, content, url));
    }
  }

  const fetched = await fetchArticle(url);
  if (fetched.format === "pdf") {
    return { kind: "pdf", pdf: fetched.pdf, finalUrl: fetched.finalUrl };
  }
  const page: FetchHtmlPageResult = {
    content: fetched.content,
    isMarkdown: fetched.isMarkdown,
    finalUrl: fetched.finalUrl,
  };
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

/**
 * `url` in the canonical form its saved-article plugin declares
 * (`SavedArticleCapability.normalizeUrl`), or unchanged when none does.
 */
export function normalizeSavedArticleUrl(url: string): string {
  const parsed = toUrl(url);
  const plugin = parsed ? pluginRegistry.findWithCapability(parsed, "savedArticle") : null;
  const normalize = plugin?.capabilities.savedArticle.normalizeUrl;
  return parsed && normalize ? normalize(parsed).href : url;
}

/**
 * The web URL a link in a newsletter email leads to, per its plugin
 * (`EmailLinkCapability.resolve`): `href` unchanged when no plugin handles it,
 * null when it leads to no web content.
 */
export function resolveEmailLink(href: string): string | null {
  const parsed = toUrl(href);
  const plugin = parsed ? pluginRegistry.findWithCapability(parsed, "emailLink") : null;
  if (!parsed || !plugin) return href;
  return plugin.capabilities.emailLink.resolve(parsed)?.href ?? null;
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
  /**
   * The title to store and show for the feed: its own title, else
   * `previousTitle` (what we stored last time, already resolved), else the
   * feed URL's hostname, with the plugin's transform applied (e.g. a LessWrong
   * user feed gets its author appended, from the first entry with one). Null
   * only when there's nothing at all to fall back to.
   */
  resolveFeedTitle(
    feed: { title?: string; items: readonly ParsedEntry[] },
    previousTitle?: string | null
  ): string | null;
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

  const pluginTransformFeedTitle = feed?.transformFeedTitle?.bind(feed);
  const transformFeedTitle = guarded(
    "transformFeedTitle",
    pluginTransformFeedTitle && parsed
      ? (title: string, items: readonly ParsedEntry[]) =>
          pluginTransformFeedTitle(title, parsed, {
            firstAuthor: items.find((item) => item.author)?.author ?? null,
          })
      : undefined,
    (title) => title
  );
  return {
    resolveFeedTitle(parsedFeed, previousTitle) {
      if (parsedFeed.title) return transformFeedTitle(parsedFeed.title, parsedFeed.items);
      if (previousTitle) return previousTitle;
      return parsed?.hostname ? transformFeedTitle(parsed.hostname, parsedFeed.items) : null;
    },
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
