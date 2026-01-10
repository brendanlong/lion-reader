/**
 * Unit tests for streaming OPML parser.
 */

import { describe, it, expect } from "vitest";
import { parseOpmlStream, OpmlStreamParseError } from "../../src/server/feed/streaming/opml-parser";

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

function stringToChunkedStream(str: string, chunkSize: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.slice(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

async function collectFeeds<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

describe("parseOpmlStream", () => {
  describe("standard OPML", () => {
    it("parses a basic OPML file with feeds", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head>
            <title>My Subscriptions</title>
          </head>
          <body>
            <outline type="rss" text="Example Blog" title="Example Blog"
                     xmlUrl="https://example.com/feed.xml" htmlUrl="https://example.com"/>
            <outline type="rss" text="Another Blog"
                     xmlUrl="https://another.com/rss"/>
          </body>
        </opml>`;

      const result = await parseOpmlStream(stringToStream(xml));
      const feeds = await collectFeeds(result.feeds);

      expect(feeds).toHaveLength(2);
      expect(feeds[0]).toEqual({
        title: "Example Blog",
        xmlUrl: "https://example.com/feed.xml",
        htmlUrl: "https://example.com",
      });
      expect(feeds[1]).toEqual({
        title: "Another Blog",
        xmlUrl: "https://another.com/rss",
        htmlUrl: undefined,
      });
    });

    it("handles chunked streaming correctly", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
          <body>
            <outline type="rss" text="Feed" xmlUrl="https://example.com/feed.xml"/>
          </body>
        </opml>`;

      const result = await parseOpmlStream(stringToChunkedStream(xml, 20));
      const feeds = await collectFeeds(result.feeds);

      expect(feeds).toHaveLength(1);
      expect(feeds[0].title).toBe("Feed");
    });
  });

  describe("nested folders", () => {
    it("parses nested folder structure with categories", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>My Subscriptions</title></head>
          <body>
            <outline text="Tech">
              <outline text="Programming">
                <outline type="rss" text="Coding Blog" xmlUrl="https://coding.com/feed"/>
              </outline>
              <outline type="rss" text="Tech News" xmlUrl="https://technews.com/rss"/>
            </outline>
            <outline type="rss" text="Uncategorized" xmlUrl="https://uncategorized.com/feed"/>
          </body>
        </opml>`;

      const result = await parseOpmlStream(stringToStream(xml));
      const feeds = await collectFeeds(result.feeds);

      expect(feeds).toHaveLength(3);

      expect(feeds[0]).toEqual({
        title: "Coding Blog",
        xmlUrl: "https://coding.com/feed",
        htmlUrl: undefined,
        category: ["Tech", "Programming"],
      });

      expect(feeds[1]).toEqual({
        title: "Tech News",
        xmlUrl: "https://technews.com/rss",
        htmlUrl: undefined,
        category: ["Tech"],
      });

      expect(feeds[2]).toEqual({
        title: "Uncategorized",
        xmlUrl: "https://uncategorized.com/feed",
        htmlUrl: undefined,
      });
    });
  });

  describe("category attribute", () => {
    it("uses category attribute when present", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
          <body>
            <outline type="rss" text="Feed" xmlUrl="https://example.com/feed" category="News"/>
          </body>
        </opml>`;

      const result = await parseOpmlStream(stringToStream(xml));
      const feeds = await collectFeeds(result.feeds);

      expect(feeds[0].category).toEqual(["News"]);
    });

    it("handles slash-separated category paths", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
          <body>
            <outline type="rss" text="Feed" xmlUrl="https://example.com/feed"
                     category="Tech/Programming/JavaScript"/>
          </body>
        </opml>`;

      const result = await parseOpmlStream(stringToStream(xml));
      const feeds = await collectFeeds(result.feeds);

      expect(feeds[0].category).toEqual(["Tech", "Programming", "JavaScript"]);
    });
  });

  describe("attribute case handling", () => {
    it("handles different attribute cases for xmlUrl", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
          <body>
            <outline type="rss" text="Feed1" xmlUrl="https://example1.com/feed"/>
            <outline type="rss" text="Feed2" xmlurl="https://example2.com/feed"/>
          </body>
        </opml>`;

      const result = await parseOpmlStream(stringToStream(xml));
      const feeds = await collectFeeds(result.feeds);

      expect(feeds).toHaveLength(2);
      expect(feeds[0].xmlUrl).toBe("https://example1.com/feed");
      expect(feeds[1].xmlUrl).toBe("https://example2.com/feed");
    });
  });

  describe("empty OPML", () => {
    it("returns empty generator for empty body", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Empty</title></head>
          <body></body>
        </opml>`;

      const result = await parseOpmlStream(stringToStream(xml));
      const feeds = await collectFeeds(result.feeds);

      expect(feeds).toEqual([]);
    });
  });

  describe("validation", () => {
    it("throws for missing opml element", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <something>
          <body></body>
        </something>`;

      await expect(parseOpmlStream(stringToStream(xml))).rejects.toThrow(OpmlStreamParseError);
      await expect(parseOpmlStream(stringToStream(xml))).rejects.toThrow("missing opml element");
    });

    it("throws for missing body element", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
        </opml>`;

      await expect(parseOpmlStream(stringToStream(xml))).rejects.toThrow(OpmlStreamParseError);
      await expect(parseOpmlStream(stringToStream(xml))).rejects.toThrow("missing body element");
    });
  });
});
