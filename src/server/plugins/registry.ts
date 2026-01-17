import type { UrlPlugin, PluginCapabilities } from "./types";

/**
 * Plugin registry with hostname-indexed lookup for O(1) performance.
 */
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
  ):
    | (UrlPlugin & {
        capabilities: Required<Pick<PluginCapabilities, K>>;
      })
    | null {
    const hostname = url.hostname.toLowerCase();
    const plugins = this.hostIndex.get(hostname);

    if (!plugins) return null;

    for (const plugin of plugins) {
      if (plugin.matchUrl(url) && plugin.capabilities[capability]) {
        return plugin as UrlPlugin & {
          capabilities: Required<Pick<PluginCapabilities, K>>;
        };
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
