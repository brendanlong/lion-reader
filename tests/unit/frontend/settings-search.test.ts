import { describe, it, expect } from "vitest";
import {
  MIN_QUERY_LENGTH,
  SETTINGS_PAGES,
  SETTINGS_SEARCH_INDEX,
  searchSettings,
} from "@/components/settings/settings-search";

const ALL = { canConfigureApiKeys: true };

function ids(query: string, options = ALL): string[] {
  return searchSettings(query, options).map((r) => r.id);
}

describe("searchSettings", () => {
  it.each(["", "   ", "!?", "how do I"])("returns nothing for the empty query %j", (query) => {
    expect(ids(query)).toEqual([]);
  });

  it("waits for enough characters to narrow the results", () => {
    expect(ids("a".repeat(MIN_QUERY_LENGTH - 1))).toEqual([]);
    expect(ids("ab".padEnd(MIN_QUERY_LENGTH, "o"))).not.toEqual([]);
  });

  it.each([
    ["theme", "theme"],
    ["dark mode", "theme"],
    ["how do I change my password", "password"],
    ["pass", "password"],
    ["pasword", "password"],
    ["THÈME", "theme"],
    ["opml", "import-export"],
    ["font size", "article-text"],
    ["openrouter", "ai-provider-keys"],
  ])("ranks the best section first for %j", (query, expected) => {
    expect(ids(query)[0]).toBe(expected);
  });

  it("ranks a title match above a keyword match", () => {
    const results = ids("narration");
    expect(results[0]).toBe("narration");
    expect(results).toContain("ai-text-processing");
  });

  it("requires every query word to match", () => {
    expect(ids("font password")).toEqual([]);
  });

  it("doesn't match short words inside other words", () => {
    // "ai" is a substring of "email" and "maintain" but only a prefix should count.
    expect(ids("ai")).not.toContain("ingest-addresses");
  });

  it("drops weak typo matches when there's a strong match", () => {
    // "them" in the ingest addresses description is one edit from "theme".
    expect(ids("theme")).toEqual(["theme"]);
  });

  it("hides API-key sections when the server can't store API keys", () => {
    expect(ids("summaries")).toContain("summaries");
    expect(ids("summaries", { canConfigureApiKeys: false })).not.toContain("summaries");
  });
});

describe("SETTINGS_SEARCH_INDEX", () => {
  it("has unique ids", () => {
    const all = SETTINGS_SEARCH_INDEX.map((e) => e.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("covers every settings page", () => {
    const pages = new Set<string>(SETTINGS_SEARCH_INDEX.map((e) => e.page));
    for (const page of SETTINGS_PAGES) expect(pages).toContain(page.href);
  });
});
