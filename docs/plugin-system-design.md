# URL Plugin System Design

## Overview

A plugin system to consolidate custom parsing logic for feeds, entries, and saved articles. Plugins register URL patterns and provide capabilities for different use cases.

## Goals

1. **Consolidate scattered URL detection** - Replace `isLessWrongUrl()`, `isGoogleDocsUrl()` checks throughout the codebase
2. **Unified interface** - All plugins implement the same interface
3. **Easy to add new plugins** - Adding ArXiv, Twitter, etc. should be self-contained
4. **Fallback behavior** - If plugin fetch fails, fall back to normal fetching
5. **Capability-based lookup** - Find first plugin that matches URL AND has the requested capability

## Plugin Interface

```typescript
// src/server/plugins/types.ts

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
}

export interface PluginCapabilities {
  feed?: FeedCapability;
  entry?: EntryCapability;
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
   * Synchronous: uses already-parsed feed data (context.firstAuthor) to avoid
   * extra network calls during feed processing.
   */
  transformFeedTitle?(title: string, feedUrl: URL, context: FeedTitleContext): string;

  /**
   * Site name to use for entries from this feed.
   * Falls back to feed's own site name if not provided.
   */
  siteName?: string;
}

export interface FeedTitleContext {
  /** First author found among the feed's parsed entries. */
  firstAuthor?: string | null;
}

// ============ Entry Capability ============

export interface EntryCapability {
  /**
   * Fetch full content for an entry URL.
   * Used when RSS provides only excerpts.
   * Return null to fall back to normal fetching.
   */
  fetchFullContent?(url: URL): Promise<EntryContent | null>;
}

export interface EntryContent {
  html: string;
  title?: string;
  author?: string;
  publishedAt?: Date;
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
  /** Storage instance for image uploads */
  storage?: Storage;
}

export interface SavedArticleContent {
  html: string;
  title?: string | null;
  author?: string | null;
  publishedAt?: Date | null;
  /** Canonical URL (may differ from input URL) */
  canonicalUrl?: string;
}
```

## Plugin Registry

```typescript
// src/server/plugins/registry.ts

export class PluginRegistry {
  private hostIndex = new Map<string, UrlPlugin[]>();

  register(plugin: UrlPlugin): void {
    for (const host of plugin.hosts) {
      const normalized = host.toLowerCase();
      const existing = this.hostIndex.get(normalized) ?? [];
      existing.push(plugin);
      this.hostIndex.set(normalized, existing);
    }
  }

  /**
   * Find the first plugin matching the URL with the given capability.
   */
  findWithCapability<K extends keyof PluginCapabilities>(
    url: URL,
    capability: K
  ): (UrlPlugin & { capabilities: Required<Pick<PluginCapabilities, K>> }) | null {
    const hostname = url.hostname.toLowerCase();
    const plugins = this.hostIndex.get(hostname);

    if (!plugins) return null;

    for (const plugin of plugins) {
      if (plugin.matchUrl(url) && plugin.capabilities[capability]) {
        return plugin as UrlPlugin & { capabilities: Required<Pick<PluginCapabilities, K>> };
      }
    }

    return null;
  }

  /**
   * Find any plugin matching the URL (regardless of capability).
   */
  findAny(url: URL): UrlPlugin | null {
    const hostname = url.hostname.toLowerCase();
    const plugins = this.hostIndex.get(hostname);

    if (!plugins) return null;

    return plugins.find((p) => p.matchUrl(url)) ?? null;
  }
}

// Global singleton
export const pluginRegistry = new PluginRegistry();
```

## Plugins

### LessWrong Plugin

```typescript
// src/server/plugins/lesswrong.ts

export const lessWrongPlugin: UrlPlugin = {
  name: "lesswrong",
  hosts: ["lesswrong.com", "www.lesswrong.com", "lesserwrong.com", "www.lesserwrong.com"],

  // The host index already restricts this plugin to LessWrong hosts, and it
  // handles every LessWrong URL (feeds, pages, posts/comments). Each capability
  // validates the specific URL shape it cares about.
  matchUrl(): boolean {
    return true;
  },

  capabilities: {
    feed: {
      async transformToFeedUrl(url: URL): Promise<URL | null> {
        // Map LessWrong pages to feeds: front page, shortform/quicktakes page,
        // user profiles (→ user posts feed), and posts (→ comment or shortform feed).
        // See the implementation for the full branch set.
        if (isLessWrongFrontpage(url.href)) return new URL(LESSWRONG_FRONTPAGE_FEED_URL);
        // ...user/post/shortform handling...
        return null;
      },

      cleanEntryContent(html: string): string {
        // Strip "Published on January 7, 2026 2:39 AM GMT<br/><br/>" prefix
        return html.replace(
          /^Published on [A-Za-z]+ \d{1,2}, \d{4} \d{1,2}:\d{2} [AP]M \w+<br\s*\/?>(<br\s*\/?>|\s)*/i,
          ""
        );
      },

      transformFeedTitle(title: string, feedUrl: URL, { firstAuthor }: FeedTitleContext): string {
        // Only user-profile feeds (feed.xml?userId=...) get the author appended.
        if (!isLessWrongUserFeedUrl(feedUrl.href)) return title;
        if (firstAuthor && !title.includes(firstAuthor)) {
          return `${title} - ${firstAuthor}`;
        }
        return title;
      },

      siteName: "LessWrong",
    },

    savedArticle: {
      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        const content = await fetchLessWrongContentFromUrl(url.href);
        if (!content) return null;

        return {
          html: content.html,
          title: content.title,
          author: content.author,
          publishedAt: content.postedAt,
          canonicalUrl: content.canonicalUrl,
        };
      },

      skipReadability: true, // GraphQL content is already clean
      siteName: "LessWrong",
    },
  },
};
```

### Google Docs Plugin

```typescript
// src/server/plugins/google-docs.ts

export const googleDocsPlugin: UrlPlugin = {
  name: "google-docs",
  hosts: ["docs.google.com"],

  matchUrl(url: URL): boolean {
    return /^\/document\/d\/[a-zA-Z0-9_-]+/.test(url.pathname);
  },

  capabilities: {
    savedArticle: {
      async fetchContent(
        url: URL,
        options: SavedArticleFetchOptions
      ): Promise<SavedArticleContent | null> {
        const normalized = normalizeGoogleDocsUrl(url.href);
        if (!normalized) return null;

        const result = await fetchPublicGoogleDoc(normalized, {
          uploadImages: options.uploadImages,
          storage: options.storage,
        });

        if (!result) return null;

        return {
          html: result.html,
          title: result.title,
          author: null,
          publishedAt: null,
          canonicalUrl: normalized,
        };
      },

      skipReadability: true, // API content is already clean
      siteName: "Google Docs",
    },
  },
};
```

### ArXiv Plugin (Future)

```typescript
// src/server/plugins/arxiv.ts

export const arxivPlugin: UrlPlugin = {
  name: "arxiv",
  hosts: ["arxiv.org", "www.arxiv.org"],

  matchUrl(url: URL): boolean {
    // Match /abs/2401.12345 or /pdf/2401.12345
    return /^\/(abs|pdf)\/\d+\.\d+/.test(url.pathname);
  },

  capabilities: {
    savedArticle: {
      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        // Transform to HTML version: /abs/2401.12345 → /html/2401.12345
        const htmlUrl = url.href
          .replace("/abs/", "/html/")
          .replace("/pdf/", "/html/")
          .replace(".pdf", "");

        // Fetch HTML version
        const response = await fetch(htmlUrl, {
          headers: { "User-Agent": USER_AGENT },
        });

        if (!response.ok) return null;

        return {
          html: await response.text(),
          title: null, // Let Readability extract it
        };
      },

      skipReadability: false, // Still want cleanup
      siteName: "arXiv",
    },
  },
};
```

## Integration Points

### 1. Plugin Registration

```typescript
// src/server/plugins/index.ts

import { pluginRegistry } from "./registry";
import { lessWrongPlugin } from "./lesswrong";
import { googleDocsPlugin } from "./google-docs";

// Register all plugins at startup
pluginRegistry.register(lessWrongPlugin);
pluginRegistry.register(googleDocsPlugin);

export { pluginRegistry } from "./registry";
export type * from "./types";
```

### 2. Saved Articles (saved.ts)

```typescript
// Before (scattered checks):
if (isGoogleDocsUrl(url)) {
  // Google Docs handling...
} else if (isLessWrongUrl(url)) {
  // LessWrong handling...
} else {
  // Normal fetch...
}

// After (unified):
const plugin = pluginRegistry.findWithCapability(new URL(url), "savedArticle");
let content: SavedArticleContent | null = null;

if (plugin) {
  try {
    content = await plugin.capabilities.savedArticle.fetchContent(new URL(url), {
      uploadImages: true,
      storage,
    });
  } catch (error) {
    logger.warn({ error, url, plugin: plugin.name }, "Plugin fetch failed, falling back");
  }
}

// Fallback to normal fetch
if (!content) {
  content = await fetchPage(url);
}

// Apply Readability unless plugin says to skip
if (!plugin?.capabilities.savedArticle.skipReadability) {
  content.html = cleanWithReadability(content.html);
}
```

### 3. Feed Content Cleaning (content-utils.ts, feeds.ts)

`getFeedPlugin(feedUrl)` (exported from `@/server/plugins`) resolves the matching
plugin from a feed-URL string, returning null for invalid URLs or unhandled hosts.

```typescript
const cleaner = getFeedPlugin(feedUrl)?.capabilities.feed.cleanEntryContent;
if (cleaner) {
  html = cleaner(html);
}
```

### 4. Feed Title (handlers.ts feed processing, feeds.ts preview)

```typescript
const transformTitle = getFeedPlugin(feedUrl)?.capabilities.feed.transformFeedTitle;
if (transformTitle) {
  const firstAuthor = parsedFeed.items.find((item) => item.author)?.author ?? null;
  feedTitle = transformTitle(feedTitle, new URL(feedUrl), { firstAuthor });
}
```

### 5. Feed Preview/Discovery URL Transform (feeds.ts)

```typescript
const transform = getFeedPlugin(url)?.capabilities.feed.transformToFeedUrl;
if (transform) {
  const feedUrl = await transform(new URL(url));
  if (feedUrl) url = feedUrl.href;
}
```

## File Structure

```
src/server/plugins/
├── index.ts          # Plugin registration, exports
├── types.ts          # PluginCapabilities, UrlPlugin interfaces
├── registry.ts       # PluginRegistry class
├── lesswrong.ts      # LessWrong plugin
├── google-docs.ts    # Google Docs plugin
└── arxiv.ts          # ArXiv plugin (future)
```

## Migration Plan

All steps below are complete:

1. **Create plugin infrastructure** - types.ts, registry.ts, index.ts ✅
2. **Create LessWrong plugin** - Wrap existing functions ✅
3. **Create Google Docs plugin** - Wrap existing functions ✅
4. **Update saved.ts** - Use plugin registry (`savedArticle` capability) ✅
5. **Update content-utils.ts / feeds.ts cleaning** - Use plugin registry (`feed.cleanEntryContent`) ✅
6. **Update feeds.ts URL transform & title** - Use plugin registry (`feed.transformToFeedUrl` / `feed.transformFeedTitle`) ✅
7. **Update handlers.ts title** - Use plugin registry (`feed.transformFeedTitle`) ✅
8. **Clean up** - Removed dead `isLessWrongFeed`; LessWrong feed logic now lives only in the plugin ✅
9. **Add ArXiv & GitHub plugins** - New plugins using the system ✅

## Testing Strategy

**Unit tests** (pure logic):

- `matchUrl()` function for each plugin
- `cleanEntryContent()` for feed plugins
- Registry lookup with various URLs and capabilities

**Integration tests** (with external services):

- Plugin fetch functions (mocked HTTP/GraphQL responses)
- Full saved article flow with plugin
- Full feed processing flow with plugin
