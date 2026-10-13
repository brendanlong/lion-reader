/**
 * Unit tests for plugin registry lookups (exact and wildcard hosts, the
 * fetched-page handler list), and the checks every registered plugin must pass.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { pluginRegistry } from "../../src/server/plugins";
import { notionPlugin } from "../../src/server/plugins/notion";
import { lessWrongPlugin } from "../../src/server/plugins/lesswrong";

const BARE_ID = "37bb1284725b81c69167c4b2a67c26e1";

describe("pluginRegistry host matching", () => {
  it("matches exact hosts case-insensitively", () => {
    const url = new URL(`https://WWW.Notion.so/Page-${BARE_ID}`);
    expect(pluginRegistry.findWithCapability(url, "savedArticle")?.name).toBe("notion");
  });

  it("matches a wildcard host's subdomains", () => {
    const url = new URL(`https://acme.notion.site/Page-${BARE_ID}`);
    expect(pluginRegistry.findWithCapability(url, "savedArticle")).toBe(notionPlugin);
    expect(pluginRegistry.findByHostname("Acme.Notion.Site")).toBe(notionPlugin);
  });

  it("does not match the wildcard's bare domain or a lookalike suffix", () => {
    expect(pluginRegistry.findByHostname("notion.site")).toBeNull();
    expect(pluginRegistry.findByHostname("acme.notion.site.evil.example")).toBeNull();
    expect(pluginRegistry.findByHostname("evilnotion.site")).toBeNull();
  });

  it("still applies matchUrl on a wildcard host", () => {
    expect(
      pluginRegistry.findWithCapability(new URL("https://acme.notion.site/"), "savedArticle")
    ).toBeNull();
  });

  it("leaves exact-host lookups for other plugins untouched", () => {
    expect(pluginRegistry.findByHostname("www.lesswrong.com")).toBe(lessWrongPlugin);
  });
});

describe("pluginRegistry.fetchedPageHandlers", () => {
  it("lists only plugins that can claim an already-fetched page", () => {
    const handlers = pluginRegistry.fetchedPageHandlers;
    expect(handlers).toContain(notionPlugin);
    expect(handlers).not.toContain(lessWrongPlugin);
    for (const plugin of handlers) {
      expect(plugin.capabilities.savedArticle.fetchContentFromPage).toBeTypeOf("function");
    }
  });
});

describe("every registered plugin", () => {
  const plugins = pluginRegistry.plugins;

  /** Plugins whose bare site root is itself a URL they handle, and why. */
  const HANDLES_SITE_ROOT: Record<string, string> = {
    lesswrong: "the front page maps to the frontpage feed",
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("declares lowercase hosts, none claimed by two plugins", () => {
    const owners = new Map<string, string>();
    for (const plugin of plugins) {
      for (const host of plugin.hosts) {
        expect(host).toBe(host.toLowerCase());
        expect(owners.get(host), `${host} is claimed twice`).toBeUndefined();
        owners.set(host, plugin.name);
      }
    }
  });

  it.each(plugins.map((plugin) => [plugin.name, plugin] as const))(
    "%s declines its bare site roots unless it handles them on purpose",
    (name, plugin) => {
      const exactHosts = plugin.hosts.filter((host) => !host.startsWith("*."));
      const rootMatches = exactHosts.map((host) => plugin.matchUrl(new URL(`https://${host}/`)));
      if (name in HANDLES_SITE_ROOT) {
        expect(rootMatches).toContain(true);
      } else {
        expect(rootMatches.every((matched) => !matched)).toBe(true);
      }
    }
  );

  it.each(pluginRegistry.fetchedPageHandlers.map((plugin) => [plugin.name, plugin] as const))(
    "%s declines an ordinary fetched page without a network call",
    async (_name, plugin) => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network"));
      const content = await plugin.capabilities.savedArticle.fetchContentFromPage!({
        html: "<html><head><title>Post</title></head><body><article>Real article</article></body></html>",
        url: new URL("https://example.com/post"),
      });
      expect(content).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );
});
