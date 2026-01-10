/**
 * Unit tests for streaming Atom feed parser.
 */

import { describe, it, expect } from "vitest";
import { parseAtomStream } from "../../src/server/feed/streaming/atom-parser";

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

describe("parseAtomStream", () => {
  describe("standard Atom 1.0 feed", () => {
    it("parses a standard Atom feed with all elements", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Example Atom Feed</title>
          <subtitle>An example Atom feed</subtitle>
          <link href="https://example.com" rel="alternate"/>
          <link href="https://example.com/feed.xml" rel="self"/>
          <icon>https://example.com/icon.png</icon>
          <entry>
            <id>urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a</id>
            <title>First Entry</title>
            <link href="https://example.com/entry-1" rel="alternate"/>
            <summary>This is the first entry</summary>
            <content type="html">This is the full content</content>
            <published>2024-01-01T12:00:00Z</published>
            <author>
              <name>John Doe</name>
            </author>
          </entry>
          <entry>
            <id>urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6b</id>
            <title>Second Entry</title>
            <link href="https://example.com/entry-2"/>
            <updated>2024-01-02T12:00:00Z</updated>
          </entry>
        </feed>`;

      const feed = await parseAtomStream(stringToStream(xml));

      expect(feed.title).toBe("Example Atom Feed");
      expect(feed.description).toBe("An example Atom feed");
      expect(feed.siteUrl).toBe("https://example.com");
      expect(feed.selfUrl).toBe("https://example.com/feed.xml");
      expect(feed.iconUrl).toBe("https://example.com/icon.png");
      expect(feed.items).toHaveLength(2);

      expect(feed.items[0].guid).toBe("urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a");
      expect(feed.items[0].title).toBe("First Entry");
      expect(feed.items[0].link).toBe("https://example.com/entry-1");
      expect(feed.items[0].summary).toBe("This is the first entry");
      expect(feed.items[0].content).toBe("This is the full content");
      expect(feed.items[0].author).toBe("John Doe");
      expect(feed.items[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));

      expect(feed.items[1].title).toBe("Second Entry");
      expect(feed.items[1].pubDate).toEqual(new Date("2024-01-02T12:00:00Z"));
    });

    it("handles chunked streaming correctly", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Chunked Feed</title>
          <entry>
            <id>1</id>
            <title>First Entry</title>
            <link href="https://example.com/entry-1"/>
          </entry>
        </feed>`;

      // Send in very small chunks to test streaming
      const feed = await parseAtomStream(stringToChunkedStream(xml, 20));

      expect(feed.title).toBe("Chunked Feed");
      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].title).toBe("First Entry");
    });
  });

  describe("feed-level elements", () => {
    it("uses logo as icon fallback", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Feed with Logo</title>
          <logo>https://example.com/logo.png</logo>
        </feed>`;

      const feed = await parseAtomStream(stringToStream(xml));

      expect(feed.iconUrl).toBe("https://example.com/logo.png");
    });

    it("prefers icon over logo", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Feed with Both</title>
          <icon>https://example.com/icon.png</icon>
          <logo>https://example.com/logo.png</logo>
        </feed>`;

      const feed = await parseAtomStream(stringToStream(xml));

      expect(feed.iconUrl).toBe("https://example.com/icon.png");
    });
  });

  describe("entry dates", () => {
    it("prefers published over updated", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Date Test Feed</title>
          <entry>
            <id>1</id>
            <title>Entry</title>
            <published>2024-01-01T12:00:00Z</published>
            <updated>2024-06-15T12:00:00Z</updated>
          </entry>
        </feed>`;

      const feed = await parseAtomStream(stringToStream(xml));

      expect(feed.items[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));
    });

    it("falls back to updated when published is missing", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Date Test Feed</title>
          <entry>
            <id>1</id>
            <title>Entry</title>
            <updated>2024-06-15T12:00:00Z</updated>
          </entry>
        </feed>`;

      const feed = await parseAtomStream(stringToStream(xml));

      expect(feed.items[0].pubDate).toEqual(new Date("2024-06-15T12:00:00Z"));
    });
  });

  describe("WebSub discovery", () => {
    it("extracts hub URL from link elements", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>WebSub Feed</title>
          <link href="https://pubsubhubbub.appspot.com" rel="hub"/>
          <link href="https://example.com/feed.xml" rel="self"/>
        </feed>`;

      const feed = await parseAtomStream(stringToStream(xml));

      expect(feed.hubUrl).toBe("https://pubsubhubbub.appspot.com");
      expect(feed.selfUrl).toBe("https://example.com/feed.xml");
    });
  });

  describe("Syndication namespace", () => {
    it("parses sy:updatePeriod and sy:updateFrequency", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom"
              xmlns:sy="http://purl.org/rss/1.0/modules/syndication/">
          <title>Syndication Feed</title>
          <sy:updatePeriod>weekly</sy:updatePeriod>
          <sy:updateFrequency>1</sy:updateFrequency>
        </feed>`;

      const feed = await parseAtomStream(stringToStream(xml));

      expect(feed.syndication).toEqual({
        updatePeriod: "weekly",
        updateFrequency: 1,
      });
    });
  });

  describe("content handling", () => {
    it("prefers content over summary", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Content Feed</title>
          <entry>
            <id>1</id>
            <title>Entry</title>
            <summary>Short summary</summary>
            <content type="html"><![CDATA[<p>Full content here</p>]]></content>
          </entry>
        </feed>`;

      const feed = await parseAtomStream(stringToStream(xml));

      expect(feed.items[0].content).toBe("<p>Full content here</p>");
      expect(feed.items[0].summary).toBe("Short summary");
    });

    it("uses summary as content when content is missing", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Summary Only Feed</title>
          <entry>
            <id>1</id>
            <title>Entry</title>
            <summary>This is both summary and content</summary>
          </entry>
        </feed>`;

      const feed = await parseAtomStream(stringToStream(xml));

      expect(feed.items[0].content).toBe("This is both summary and content");
      expect(feed.items[0].summary).toBe("This is both summary and content");
    });
  });

  describe("link handling", () => {
    it("extracts link without rel attribute (defaults to alternate)", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Link Test Feed</title>
          <link href="https://example.com"/>
          <entry>
            <id>1</id>
            <title>Entry</title>
            <link href="https://example.com/entry"/>
          </entry>
        </feed>`;

      const feed = await parseAtomStream(stringToStream(xml));

      expect(feed.siteUrl).toBe("https://example.com");
      expect(feed.items[0].link).toBe("https://example.com/entry");
    });
  });
});
