import type { UrlPlugin, PluginCapabilities } from "./types";

/**
 * Plugin registry with hostname-indexed lookup for O(1) performance.
 */
export class PluginRegistry {
  private hostIndex = new Map<string, UrlPlugin[]>();

  register(plugin: UrlPlugin): void {
    console.log(`[PluginRegistry] Registering plugin: ${plugin.name}`, {
      hosts: plugin.hosts,
      capabilities: Object.keys(plugin.capabilities),
    });
    for (const host of plugin.hosts) {
      const normalized = host.toLowerCase();
      const existing = this.hostIndex.get(normalized) ?? [];
      existing.push(plugin);
      this.hostIndex.set(normalized, existing);
    }
    console.log(`[PluginRegistry] Registry state after registration:`, {
      totalHosts: this.hostIndex.size,
      hosts: Array.from(this.hostIndex.keys()),
    });
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

    console.log(`[PluginRegistry] Looking for plugin for ${hostname}`, {
      registrySize: this.hostIndex.size,
      availableHosts: Array.from(this.hostIndex.keys()),
      pluginsForHost: plugins?.length ?? 0,
      capability,
    });

    if (!plugins) {
      return null;
    }

    for (const plugin of plugins) {
      const matches = plugin.matchUrl(url);
      const hasCapability = !!plugin.capabilities[capability];

      console.log(`[PluginRegistry] Checking ${plugin.name}:`, {
        matches,
        hasCapability,
      });

      if (matches && hasCapability) {
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
