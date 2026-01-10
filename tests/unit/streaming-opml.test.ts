/**
 * Unit tests for streaming OPML parser.
 */

import { describe, it, expect } from "vitest";
import { parseOpmlStream, OpmlStreamParseError } from "../../src/server/feed/streaming/opml-parser";

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

/**
 * Helper to create a ReadableStream that sends data in chunks.
 */
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

      const feeds = await parseOpmlStream(stringToStream(xml));

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

      const feeds = await parseOpmlStream(stringToChunkedStream(xml, 20));

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

      const feeds = await parseOpmlStream(stringToStream(xml));

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

      const feeds = await parseOpmlStream(stringToStream(xml));

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

      const feeds = await parseOpmlStream(stringToStream(xml));

      expect(feeds[0].category).toEqual(["Tech", "Programming", "JavaScript"]);
    });

    it("handles comma-separated categories (takes first)", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
          <body>
            <outline type="rss" text="Feed" xmlUrl="https://example.com/feed"
                     category="News, Tech, Sports"/>
          </body>
        </opml>`;

      const feeds = await parseOpmlStream(stringToStream(xml));

      expect(feeds[0].category).toEqual(["News"]);
    });

    it("prefers folder hierarchy over category attribute", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
          <body>
            <outline text="Folder">
              <outline type="rss" text="Feed" xmlUrl="https://example.com/feed"
                       category="Different"/>
            </outline>
          </body>
        </opml>`;

      const feeds = await parseOpmlStream(stringToStream(xml));

      expect(feeds[0].category).toEqual(["Folder"]);
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

      const feeds = await parseOpmlStream(stringToStream(xml));

      expect(feeds).toHaveLength(2);
      expect(feeds[0].xmlUrl).toBe("https://example1.com/feed");
      expect(feeds[1].xmlUrl).toBe("https://example2.com/feed");
    });

    it("handles different attribute cases for htmlUrl", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
          <body>
            <outline type="rss" text="Feed1" xmlUrl="https://example1.com/feed"
                     htmlUrl="https://example1.com"/>
            <outline type="rss" text="Feed2" xmlUrl="https://example2.com/feed"
                     htmlurl="https://example2.com"/>
          </body>
        </opml>`;

      const feeds = await parseOpmlStream(stringToStream(xml));

      expect(feeds[0].htmlUrl).toBe("https://example1.com");
      expect(feeds[1].htmlUrl).toBe("https://example2.com");
    });
  });

  describe("title handling", () => {
    it("prefers text over title attribute", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
          <body>
            <outline type="rss" text="Text Title" title="Title Attr"
                     xmlUrl="https://example.com/feed"/>
          </body>
        </opml>`;

      const feeds = await parseOpmlStream(stringToStream(xml));

      expect(feeds[0].title).toBe("Text Title");
    });

    it("falls back to title attribute when text is missing", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
          <body>
            <outline type="rss" title="Title Attr" xmlUrl="https://example.com/feed"/>
          </body>
        </opml>`;

      const feeds = await parseOpmlStream(stringToStream(xml));

      expect(feeds[0].title).toBe("Title Attr");
    });
  });

  describe("empty OPML", () => {
    it("returns empty array for empty body", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Empty</title></head>
          <body></body>
        </opml>`;

      const feeds = await parseOpmlStream(stringToStream(xml));

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
