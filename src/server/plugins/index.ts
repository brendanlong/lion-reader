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
import { logger } from "@/lib/logger";

// Register all available plugins at module load time
pluginRegistry.register(lessWrongPlugin);
pluginRegistry.register(googleDocsPlugin);
pluginRegistry.register(arxivPlugin);
pluginRegistry.register(githubPlugin);
pluginRegistry.register(youtubePlugin);
pluginRegistry.register(blueskyPlugin);
pluginRegistry.register(linkedInPlugin);
pluginRegistry.register(threadsPlugin);
pluginRegistry.register(notionPlugin);

logger.info("Plugins registered", {
  plugins: [
    lessWrongPlugin.name,
    googleDocsPlugin.name,
    arxivPlugin.name,
    githubPlugin.name,
    youtubePlugin.name,
    blueskyPlugin.name,
    linkedInPlugin.name,
    threadsPlugin.name,
    notionPlugin.name,
  ],
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

/**
 * Resolve the feed-capable plugin for a feed or page URL string.
 *
 * Returns the matching plugin (with its `feed` capability) or null if the URL is
 * invalid or no plugin handles it. Use this at feed-processing call sites so
 * feed-source customization lives in plugins rather than hardcoded branches.
 */
export function getFeedPlugin(url: string | URL | null | undefined) {
  if (!url) return null;

  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(url);
  } catch {
    return null;
  }

  return pluginRegistry.findWithCapability(parsed, "feed");
}

/**
 * Whether new subscriptions to this feed URL should default `fetch_full_content`
 * on (a plugin opt-in for sources whose feed entries are truncated or drop
 * embedded content, e.g. Bluesky). Returns false for an invalid/unhandled URL.
 */
export function feedDefaultsToFullContent(url: string | URL | null | undefined): boolean {
  if (!url) return false;

  let parsed: URL;
  try {
    parsed = url instanceof URL ? url : new URL(url);
  } catch {
    return false;
  }

  return pluginRegistry.feedDefaultsToFullContent(parsed);
}

// Export registry and types
export { pluginRegistry } from "./registry";
export type * from "./types";
