/**
 * Unit tests for plugin registry lookups: exact and wildcard hosts, and the
 * fetched-page handler list.
 */

import { describe, it, expect } from "vitest";
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
    expect(pluginRegistry.findAny(new URL("https://acme.notion.site/"))).toBeNull();
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
