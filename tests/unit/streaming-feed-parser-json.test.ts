/**
 * Unit tests for streaming JSON Feed parser.
 */

import { describe, it, expect } from "vitest";
import { parseJsonStream } from "../../src/server/feed/streaming/json-parser";

/**
 * Helper to create a ReadableStream from a string.
 */
function stringToStream(str: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);

  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("parseJsonStream", () => {
  describe("standard JSON Feed 1.1", () => {
    it("parses a standard JSON Feed with all elements", async () => {
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

      const feed = await parseJsonStream(stringToStream(json));

      expect(feed.title).toBe("Example JSON Feed");
      expect(feed.description).toBe("An example JSON feed");
      expect(feed.siteUrl).toBe("https://example.com");
      expect(feed.selfUrl).toBe("https://example.com/feed.json");
      expect(feed.iconUrl).toBe("https://example.com/favicon.ico");
      expect(feed.items).toHaveLength(2);

      expect(feed.items[0].guid).toBe("item-1");
      expect(feed.items[0].link).toBe("https://example.com/item-1");
      expect(feed.items[0].title).toBe("First Item");
      expect(feed.items[0].summary).toBe("This is the summary");
      expect(feed.items[0].content).toBe("<p>This is the full content</p>");
      expect(feed.items[0].author).toBe("John Doe");
      expect(feed.items[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));

      expect(feed.items[1].title).toBe("Second Item");
      expect(feed.items[1].content).toBe("Plain text content");
    });
  });

  describe("JSON Feed 1.0 compatibility", () => {
    it("supports deprecated author field", async () => {
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

      const feed = await parseJsonStream(stringToStream(json));

      expect(feed.items[0].author).toBe("Jane Doe");
    });

    it("prefers authors array over deprecated author", async () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        items: [
          {
            id: "1",
            title: "Item",
            authors: [{ name: "New Author" }],
            author: { name: "Old Author" },
          },
        ],
      });

      const feed = await parseJsonStream(stringToStream(json));

      expect(feed.items[0].author).toBe("New Author");
    });
  });

  describe("content handling", () => {
    it("prefers content_html over content_text", async () => {
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

      const feed = await parseJsonStream(stringToStream(json));

      expect(feed.items[0].content).toBe("<p>HTML content</p>");
    });

    it("uses content_text as summary when summary is missing", async () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        items: [
          {
            id: "1",
            title: "Item",
            content_text: "Plain text only",
          },
        ],
      });

      const feed = await parseJsonStream(stringToStream(json));

      expect(feed.items[0].summary).toBe("Plain text only");
      expect(feed.items[0].content).toBe("Plain text only");
    });
  });

  describe("date handling", () => {
    it("prefers date_published over date_modified", async () => {
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

      const feed = await parseJsonStream(stringToStream(json));

      expect(feed.items[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));
    });

    it("falls back to date_modified when date_published is missing", async () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        items: [
          {
            id: "1",
            title: "Item",
            date_modified: "2024-06-15T12:00:00Z",
          },
        ],
      });

      const feed = await parseJsonStream(stringToStream(json));

      expect(feed.items[0].pubDate).toEqual(new Date("2024-06-15T12:00:00Z"));
    });
  });

  describe("icon handling", () => {
    it("prefers favicon over icon", async () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        favicon: "https://example.com/favicon.ico",
        icon: "https://example.com/icon.png",
        items: [],
      });

      const feed = await parseJsonStream(stringToStream(json));

      expect(feed.iconUrl).toBe("https://example.com/favicon.ico");
    });

    it("uses icon when favicon is missing", async () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        icon: "https://example.com/icon.png",
        items: [],
      });

      const feed = await parseJsonStream(stringToStream(json));

      expect(feed.iconUrl).toBe("https://example.com/icon.png");
    });
  });

  describe("URL handling", () => {
    it("uses external_url as link fallback", async () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        items: [
          {
            id: "1",
            title: "Item",
            external_url: "https://external.example.com/article",
          },
        ],
      });

      const feed = await parseJsonStream(stringToStream(json));

      expect(feed.items[0].link).toBe("https://external.example.com/article");
    });

    it("prefers url over external_url", async () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        items: [
          {
            id: "1",
            title: "Item",
            url: "https://example.com/article",
            external_url: "https://external.example.com/article",
          },
        ],
      });

      const feed = await parseJsonStream(stringToStream(json));

      expect(feed.items[0].link).toBe("https://example.com/article");
    });
  });

  describe("WebSub hub support", () => {
    it("extracts WebSub hub URL", async () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        hubs: [{ type: "websub", url: "https://hub.example.com" }],
        items: [],
      });

      const feed = await parseJsonStream(stringToStream(json));

      expect(feed.hubUrl).toBe("https://hub.example.com");
    });

    it("falls back to first hub when no websub hub", async () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        hubs: [{ type: "other", url: "https://other-hub.example.com" }],
        items: [],
      });

      const feed = await parseJsonStream(stringToStream(json));

      expect(feed.hubUrl).toBe("https://other-hub.example.com");
    });
  });

  describe("validation", () => {
    it("throws for invalid JSON", async () => {
      await expect(parseJsonStream(stringToStream("not json"))).rejects.toThrow();
    });

    it("throws for missing version", async () => {
      const json = JSON.stringify({
        title: "Feed",
        items: [],
      });

      await expect(parseJsonStream(stringToStream(json))).rejects.toThrow("invalid version");
    });

    it("throws for invalid version", async () => {
      const json = JSON.stringify({
        version: "1.0",
        title: "Feed",
        items: [],
      });

      await expect(parseJsonStream(stringToStream(json))).rejects.toThrow("invalid version");
    });

    it("throws for missing items array", async () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
      });

      await expect(parseJsonStream(stringToStream(json))).rejects.toThrow("missing items");
    });
  });
});
