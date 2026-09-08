import type { UrlPlugin, PluginCapabilities, PluginWith } from "./types";

/**
 * Plugin registry with hostname-indexed lookup for O(1) performance.
 *
 * A host of the form `*.example.com` matches any subdomain (not the bare
 * domain); those are checked by suffix after the exact index misses.
 */
class PluginRegistry {
  private hostIndex = new Map<string, UrlPlugin[]>();
  private wildcardHosts: { suffix: string; plugin: UrlPlugin }[] = [];
  private fetchedPagePlugins: PluginWith<"savedArticle">[] = [];

  register(plugin: UrlPlugin): void {
    for (const host of plugin.hosts) {
      const normalized = host.toLowerCase();
      if (normalized.startsWith("*.")) {
        this.wildcardHosts.push({ suffix: normalized.slice(1), plugin });
        continue;
      }
      const existing = this.hostIndex.get(normalized) ?? [];
      existing.push(plugin);
      this.hostIndex.set(normalized, existing);
    }
    if (plugin.capabilities.savedArticle?.fetchContentFromPage) {
      this.fetchedPagePlugins.push(plugin as PluginWith<"savedArticle">);
    }
  }

  private pluginsForHostname(hostname: string): UrlPlugin[] {
    const normalized = hostname.toLowerCase();
    const exact = this.hostIndex.get(normalized) ?? [];
    const wildcard = this.wildcardHosts
      .filter(({ suffix }) => normalized.endsWith(suffix))
      .map(({ plugin }) => plugin);
    return wildcard.length > 0 ? [...exact, ...wildcard] : exact;
  }

  /**
   * Find the first plugin matching the URL with the given capability.
   */
  findWithCapability<K extends keyof PluginCapabilities>(
    url: URL,
    capability: K
  ): PluginWith<K> | null {
    for (const plugin of this.pluginsForHostname(url.hostname)) {
      if (plugin.matchUrl(url) && plugin.capabilities[capability]) {
        return plugin as PluginWith<K>;
      }
    }
    return null;
  }

  /**
   * Find any plugin matching the URL (regardless of capability).
   */
  findAny(url: URL): UrlPlugin | null {
    return this.pluginsForHostname(url.hostname).find((p) => p.matchUrl(url)) ?? null;
  }

  /**
   * Find the first plugin registered for a hostname.
   * Unlike findAny, this only checks hostname, not matchUrl.
   * Useful for site-level metadata like feedBuilderUrl.
   */
  findByHostname(hostname: string): UrlPlugin | null {
    return this.pluginsForHostname(hostname)[0] ?? null;
  }

  /**
   * Whether a plugin registered for this *feed URL*'s hostname declares that new
   * subscriptions should default `fetch_full_content` on. Matched by hostname
   * plus the plugin's own `feedDefaultsToFullContent` predicate — deliberately
   * NOT gated on `matchUrl`, which matches entry URLs, not the feed URL.
   */
  feedDefaultsToFullContent(feedUrl: URL): boolean {
    return this.pluginsForHostname(feedUrl.hostname).some(
      (p) => p.feedDefaultsToFullContent?.(feedUrl) ?? false
    );
  }

  /**
   * Plugins that can recognize their source from an already-fetched page
   * (`SavedArticleCapability.fetchContentFromPage`), for pages no hostname
   * lookup claimed.
   */
  get fetchedPageHandlers(): readonly PluginWith<"savedArticle">[] {
    return this.fetchedPagePlugins;
  }
}

// Global singleton
export const pluginRegistry = new PluginRegistry();
