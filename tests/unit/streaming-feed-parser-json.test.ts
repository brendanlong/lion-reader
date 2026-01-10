/**
 * Unit tests for streaming JSON Feed parser.
 */

import { describe, it, expect } from "vitest";
import { parseJsonStream } from "../../src/server/feed/streaming/json-parser";

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

async function collectEntries<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
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

      const result = await parseJsonStream(stringToStream(json));

      expect(result.title).toBe("Example JSON Feed");
      expect(result.description).toBe("An example JSON feed");
      expect(result.siteUrl).toBe("https://example.com");
      expect(result.selfUrl).toBe("https://example.com/feed.json");
      expect(result.iconUrl).toBe("https://example.com/favicon.ico");

      const entries = await collectEntries(result.entries);
      expect(entries).toHaveLength(2);

      expect(entries[0].guid).toBe("item-1");
      expect(entries[0].link).toBe("https://example.com/item-1");
      expect(entries[0].title).toBe("First Item");
      expect(entries[0].summary).toBe("This is the summary");
      expect(entries[0].content).toBe("<p>This is the full content</p>");
      expect(entries[0].author).toBe("John Doe");
      expect(entries[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));

      expect(entries[1].title).toBe("Second Item");
      expect(entries[1].content).toBe("Plain text content");
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

      const result = await parseJsonStream(stringToStream(json));
      const entries = await collectEntries(result.entries);

      expect(entries[0].author).toBe("Jane Doe");
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

      const result = await parseJsonStream(stringToStream(json));
      const entries = await collectEntries(result.entries);

      expect(entries[0].content).toBe("<p>HTML content</p>");
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

      const result = await parseJsonStream(stringToStream(json));
      const entries = await collectEntries(result.entries);

      expect(entries[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));
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

      const result = await parseJsonStream(stringToStream(json));

      expect(result.iconUrl).toBe("https://example.com/favicon.ico");
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

      const result = await parseJsonStream(stringToStream(json));

      expect(result.hubUrl).toBe("https://hub.example.com");
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

    it("throws for missing items array", async () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
      });

      await expect(parseJsonStream(stringToStream(json))).rejects.toThrow("missing items");
    });
  });
});
