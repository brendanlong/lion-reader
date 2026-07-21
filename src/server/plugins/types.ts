/**
 * URL Plugin System
 * Consolidates custom parsing logic for feeds, entries, and saved articles.
 */

import type { ParsedEntry } from "@/server/feed/types";

/**
 * Core plugin interface with hostname-based registry support.
 */
export interface UrlPlugin {
  /** Unique identifier for the plugin */
  name: string;

  /** Hostnames this plugin handles (for O(1) lookup) */
  hosts: string[];

  /**
   * More specific URL matching after hostname match.
   * Return true if this plugin should handle the URL.
   */
  matchUrl(url: URL): boolean;

  /** Plugin capabilities */
  capabilities: PluginCapabilities;

  /**
   * Optional URL to an external tool for building custom feed URLs for this site.
   * Shown on the feed discovery/disambiguation page when subscribing.
   * E.g., a LessWrong RSS feed builder tool.
   */
  feedBuilderUrl?: string;

  /**
   * Optional: whether new subscriptions to this *feed URL* (not an entry URL)
   * should start with `fetch_full_content` enabled, so the reader hydrates each
   * entry's full content automatically on open. For sources whose feed entries
   * are truncated or drop embedded content — e.g. Bluesky's native RSS, which
   * renders quote posts/images/link cards as a bare placeholder — but whose
   * `savedArticle` capability can fetch the real content. Defaults to false when
   * absent. Only applied on a fresh subscribe, never overriding a resubscribe's
   * stored preference.
   */
  feedDefaultsToFullContent?(feedUrl: URL): boolean;
}

export interface PluginCapabilities {
  feed?: FeedCapability;
  savedArticle?: SavedArticleCapability;
}

// ============ Feed Capability ============

export interface FeedCapability {
  /**
   * Transform a URL into a feed URL.
   * E.g., LessWrong user profile → RSS feed URL
   * Return null if URL can't be transformed.
   */
  transformToFeedUrl?(url: URL): Promise<URL | null>;

  /**
   * Clean entry content from this feed.
   * E.g., strip "Published on..." prefix from LessWrong.
   * Runs synchronously during feed processing.
   */
  cleanEntryContent?(html: string): string;

  /**
   * Synthesize entry content HTML from the parsed entry, for sources whose
   * feed entries carry no usable HTML body. E.g., YouTube feeds provide only
   * Media RSS metadata, from which the plugin builds a video embed plus the
   * description. The result is stored as the entry's cleaned content (the
   * feed-provided content, if any, remains the original).
   * Runs synchronously during feed processing; return null to fall back to
   * normal content handling.
   */
  buildEntryContent?(entry: ParsedEntry, entryUrl: string | undefined): string | null;

  /**
   * Transform feed title after parsing.
   * E.g., append author name to LessWrong user feeds.
   * Runs synchronously during feed processing, using already-parsed feed data
   * (passed via context) to avoid extra network calls.
   */
  transformFeedTitle?(title: string, feedUrl: URL, context?: FeedTitleContext): string;

  /**
   * Site name to use for entries from this feed.
   * Falls back to feed's own site name if not provided.
   */
  siteName?: string;

  /**
   * Minimum polling interval in seconds for feeds from this source, raising
   * the floor on the scheduler's success-path interval (it never lowers the
   * context minimum, and failure backoff is unaffected).
   * E.g. YouTube serves `Cache-Control: max-age=900`, but polling every
   * channel every 15 minutes is a fast way to get an IP rate-limited.
   */
  minFetchIntervalSeconds?: number;
}

export interface FeedTitleContext {
  /** First author found among the feed's parsed entries (used to append to user-profile feed titles). */
  firstAuthor?: string | null;
}

// ============ Saved Article Capability ============

export interface SavedArticleCapability {
  /**
   * Fetch content for a saved article.
   * Return null to fall back to normal fetching.
   */
  fetchContent(url: URL, options: SavedArticleFetchOptions): Promise<SavedArticleContent | null>;

  /**
   * Whether to skip Readability processing.
   * True if content is already clean (e.g., Google Docs API).
   * Default: false
   */
  skipReadability?: boolean;

  /**
   * Site name to use for this saved article.
   */
  siteName?: string;
}

export interface SavedArticleFetchOptions {
  /** Upload images to storage */
  uploadImages?: boolean;
}

export interface SavedArticleContent {
  /**
   * Article HTML as a bare body fragment, NOT a wrapped `<html>` document.
   * With `skipReadability` the html is stored as the article body verbatim,
   * and the read-path sanitizer drops `<title>`/`<head>` tags but keeps their
   * text — a wrapped document would leak the title as stray body text.
   */
  html: string;
  title?: string | null;
  author?: string | null;
  /**
   * Plain-text excerpt/summary supplied by the plugin (e.g. the arXiv API
   * abstract). When present it is preferred over Readability's extracted excerpt
   * (see {@link computeSavedArticleExcerpt}) and truncated to the summary length
   * downstream. Plain text, not HTML — it is stored/rendered as escaped text.
   */
  excerpt?: string | null;
  publishedAt?: Date | null;
  /** Canonical URL (may differ from input URL) */
  canonicalUrl?: string;
}
