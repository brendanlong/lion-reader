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
  emailLink?: EmailLinkCapability;
}

/** A plugin known to declare capability `K`. */
export type PluginWith<K extends keyof PluginCapabilities> = UrlPlugin & {
  capabilities: Required<Pick<PluginCapabilities, K>>;
};

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
   * Fetch content for a saved article: HTML, or a PDF to convert like any
   * other. Return null to fall back to normal fetching.
   *
   * @param options.images - Whether to include images the plugin fetches
   *   itself (inlined as `data:` URIs): false when the content has nowhere to
   *   store them (a feed entry's), so leave them out
   */
  fetchContent(
    url: URL,
    options: { images: boolean }
  ): Promise<SavedArticleContent | SavedArticlePdf | null>;

  /**
   * Fetch content with the saving user's own credentials for the source (e.g.
   * a private Google Doc through their linked Google account). Tried when
   * `fetchContent` doesn't produce the article and the caller passes a user.
   * Throw a TRPCError when the user's credentials are missing or rejected,
   * worded per `authMode`; whatever this throws reaches the caller unmapped.
   * Return null to fall back to the generic fetch.
   */
  fetchContentAsUser?(url: URL, user: UserFetchContext): Promise<SavedArticleContent | null>;

  /**
   * The canonical form of a URL this plugin handles: a saved article's
   * identity (two URLs normalizing alike are the same saved article) and the
   * URL fetched for it.
   */
  normalizeUrl?(url: URL): URL;

  /**
   * Claim a page the generic path has already fetched, for a source that can't
   * be recognized from its URL alone (a Notion page on a customer's domain).
   * Return null to keep the page as fetched. When it runs and what it may
   * claim: ./CLAUDE.md.
   */
  fetchContentFromPage?(page: FetchedPage): Promise<SavedArticleContent | null>;

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

/**
 * How to report that the user's credentials for a source aren't set up:
 * `"interactive"` callers (the web UI) get machine-readable codes they turn
 * into an in-page consent prompt, `"non-interactive"` ones (API surfaces) a
 * human-readable message pointing the user at the web app.
 */
export type UserAuthMode = "interactive" | "non-interactive";

export interface UserFetchContext {
  userId: string;
  authMode: UserAuthMode;
}

/** A page the generic fetch retrieved, offered to `fetchContentFromPage`. */
export interface FetchedPage {
  html: string;
  /** The URL the fetch ended at, after redirects. */
  url: URL;
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
   * Plain-text excerpt/summary supplied by the plugin (e.g. the abstract off an
   * arXiv page). When present it is preferred over Readability's extracted excerpt
   * (see {@link computeSavedArticleExcerpt}) and truncated to the summary length
   * downstream. Plain text, not HTML — it is stored/rendered as escaped text.
   */
  excerpt?: string | null;
  publishedAt?: Date | null;
  /**
   * Canonical URL (may differ from input URL). It also doubles as the base the
   * save and full-content paths absolutize `html`'s relative URLs against, so a
   * plugin whose page and embedded files don't share an origin+directory has to
   * resolve them itself before returning (see `github.ts`).
   */
  canonicalUrl?: string;
}

/**
 * A PDF a plugin fetched, converted the way the generic fetch converts one
 * (Readability skipped), with the plugin's metadata preferred over the
 * document's own.
 */
export interface SavedArticlePdf extends Pick<SavedArticleContent, "title" | "author" | "excerpt"> {
  pdf: Buffer;
  /** Where the PDF was fetched from, after redirects. */
  finalUrl: string;
}

// ============ Email Link Capability ============

export interface EmailLinkCapability {
  /**
   * The web URL a link in a newsletter email leads to, for finding the post's
   * canonical URL: a cleaner form of `url` (e.g. without tracking parameters),
   * or null when it doesn't lead to web content (e.g. an app deep link).
   * Synchronous and offline: it runs while parsing the email.
   */
  resolve(url: URL): URL | null;
}
