/**
 * Unit tests for JSON Feed parser.
 */

import { describe, it, expect } from "vitest";
import { parseJson } from "../../src/server/feed/streaming/json-parser";

describe("parseJson", () => {
  describe("standard JSON Feed 1.1", () => {
    it("parses a standard JSON Feed with all elements", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Example JSON Feed",
        description: "An example JSON feed",
        home_page_url: "https://example.com",
        feed_url: "https://example.com/feed.json",
        favicon: "https://example.com/favicon.ico",
        items: [
          {
            id: "item-1",
            url: "https://example.com/item-1",
            title: "First Item",
            summary: "This is the summary",
            content_html: "<p>This is the full content</p>",
            date_published: "2024-01-01T12:00:00Z",
            authors: [{ name: "John Doe" }],
          },
          {
            id: "item-2",
            url: "https://example.com/item-2",
            title: "Second Item",
            content_text: "Plain text content",
            date_modified: "2024-01-02T12:00:00Z",
          },
        ],
      });

      const result = parseJson(json);

      expect(result.title).toBe("Example JSON Feed");
      expect(result.description).toBe("An example JSON feed");
      expect(result.siteUrl).toBe("https://example.com");
      expect(result.selfUrl).toBe("https://example.com/feed.json");
      expect(result.iconUrl).toBe("https://example.com/favicon.ico");

      expect(result.entries).toHaveLength(2);

      expect(result.entries[0].guid).toBe("item-1");
      expect(result.entries[0].link).toBe("https://example.com/item-1");
      expect(result.entries[0].title).toBe("First Item");
      expect(result.entries[0].summary).toBe("This is the summary");
      expect(result.entries[0].content).toBe("<p>This is the full content</p>");
      expect(result.entries[0].author).toBe("John Doe");
      expect(result.entries[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));

      expect(result.entries[1].title).toBe("Second Item");
      expect(result.entries[1].content).toBe("Plain text content");
    });
  });

  describe("JSON Feed 1.0 compatibility", () => {
    it("supports deprecated author field", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1",
        title: "Legacy Feed",
        items: [
          {
            id: "1",
            title: "Item with legacy author",
            author: { name: "Jane Doe" },
          },
        ],
      });

      const result = parseJson(json);

      expect(result.entries[0].author).toBe("Jane Doe");
    });
  });

  describe("content handling", () => {
    it("prefers content_html over content_text", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        items: [
          {
            id: "1",
            title: "Item",
            content_html: "<p>HTML content</p>",
            content_text: "Plain text content",
          },
        ],
      });

      const result = parseJson(json);

      expect(result.entries[0].content).toBe("<p>HTML content</p>");
    });
  });

  describe("date handling", () => {
    it("prefers date_published over date_modified", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        items: [
          {
            id: "1",
            title: "Item",
            date_published: "2024-01-01T12:00:00Z",
            date_modified: "2024-06-15T12:00:00Z",
          },
        ],
      });

      const result = parseJson(json);

      expect(result.entries[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));
    });
  });

  describe("icon handling", () => {
    it("prefers favicon over icon", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        favicon: "https://example.com/favicon.ico",
        icon: "https://example.com/icon.png",
        items: [],
      });

      const result = parseJson(json);

      expect(result.iconUrl).toBe("https://example.com/favicon.ico");
    });
  });

  describe("WebSub hub support", () => {
    it("extracts WebSub hub URL", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        hubs: [{ type: "websub", url: "https://hub.example.com" }],
        items: [],
      });

      const result = parseJson(json);

      expect(result.hubUrl).toBe("https://hub.example.com");
    });
  });

  describe("validation", () => {
    it("throws for invalid JSON", () => {
      expect(() => parseJson("not json")).toThrow();
    });

    it("throws for missing version", () => {
      const json = JSON.stringify({
        title: "Feed",
        items: [],
      });

      expect(() => parseJson(json)).toThrow("invalid version");
    });

    it("throws for missing items array", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
      });

      expect(() => parseJson(json)).toThrow("missing items");
    });
  });
});
