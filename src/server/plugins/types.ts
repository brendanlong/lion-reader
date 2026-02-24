/**
 * URL Plugin System
 * Consolidates custom parsing logic for feeds, entries, and saved articles.
 */

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
   * Transform feed title after parsing.
   * E.g., append author name to LessWrong user feeds.
   */
  transformFeedTitle?(title: string, feedUrl: URL): Promise<string>;

  /**
   * Site name to use for entries from this feed.
   * Falls back to feed's own site name if not provided.
   */
  siteName?: string;
}

// ============ Saved Article Capability ============

export interface SavedArticleCapability {
  /**
   * Fetch content for a saved article.
   * Return null to fall back to normal fetching.
   */
  fetchContent(url: URL): Promise<SavedArticleContent | null>;

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

export interface SavedArticleContent {
  html: string;
  title?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
  /** Canonical URL (may differ from input URL) */
  canonicalUrl?: string;
}
