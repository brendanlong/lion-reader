/**
 * Unit tests for streaming RSS feed parser.
 */

import { describe, it, expect } from "vitest";
import { parseRssStream } from "../../src/server/feed/streaming/rss-parser";

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

async function collectEntries<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

describe("parseRssStream", () => {
  describe("standard RSS 2.0 feed", () => {
    it("parses a standard RSS 2.0 feed with all elements", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Example Feed</title>
            <link>https://example.com</link>
            <description>An example RSS feed</description>
            <image>
              <url>https://example.com/icon.png</url>
            </image>
            <item>
              <title>First Post</title>
              <link>https://example.com/post-1</link>
              <description>This is the first post</description>
              <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
              <guid>https://example.com/post-1</guid>
              <author>author@example.com</author>
            </item>
            <item>
              <title>Second Post</title>
              <link>https://example.com/post-2</link>
              <description>This is the second post</description>
              <pubDate>Tue, 02 Jan 2024 12:00:00 GMT</pubDate>
              <guid>https://example.com/post-2</guid>
            </item>
          </channel>
        </rss>`;

      const result = await parseRssStream(stringToStream(xml));

      expect(result.title).toBe("Example Feed");
      expect(result.siteUrl).toBe("https://example.com");
      expect(result.description).toBe("An example RSS feed");
      expect(result.iconUrl).toBe("https://example.com/icon.png");

      const entries = await collectEntries(result.entries);
      expect(entries).toHaveLength(2);

      expect(entries[0].title).toBe("First Post");
      expect(entries[0].link).toBe("https://example.com/post-1");
      expect(entries[0].summary).toBe("This is the first post");
      expect(entries[0].guid).toBe("https://example.com/post-1");
      expect(entries[0].author).toBe("author@example.com");
      expect(entries[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));

      expect(entries[1].title).toBe("Second Post");
    });

    it("handles chunked streaming correctly", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Chunked Feed</title>
            <link>https://example.com</link>
            <item>
              <title>First Post</title>
              <link>https://example.com/post-1</link>
            </item>
          </channel>
        </rss>`;

      const result = await parseRssStream(stringToChunkedStream(xml, 20));

      expect(result.title).toBe("Chunked Feed");
      const entries = await collectEntries(result.entries);
      expect(entries).toHaveLength(1);
      expect(entries[0].title).toBe("First Post");
    });
  });

  describe("feed with content:encoded", () => {
    it("prefers content:encoded over description for content", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
          <channel>
            <title>Content Encoded Feed</title>
            <item>
              <title>Rich Content Post</title>
              <description>Short summary of the post</description>
              <content:encoded><![CDATA[<p>This is the <strong>full content</strong> with HTML.</p>]]></content:encoded>
            </item>
          </channel>
        </rss>`;

      const result = await parseRssStream(stringToStream(xml));
      const entries = await collectEntries(result.entries);

      expect(entries[0].content).toBe(
        "<p>This is the <strong>full content</strong> with HTML.</p>"
      );
      expect(entries[0].summary).toBe("Short summary of the post");
    });
  });

  describe("feed with dc:creator author", () => {
    it("extracts author from dc:creator", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
          <channel>
            <title>DC Creator Feed</title>
            <item>
              <title>Post with DC Creator</title>
              <dc:creator>John Doe</dc:creator>
            </item>
          </channel>
        </rss>`;

      const result = await parseRssStream(stringToStream(xml));
      const entries = await collectEntries(result.entries);

      expect(entries[0].author).toBe("John Doe");
    });
  });

  describe("WebSub discovery", () => {
    it("extracts hub and self URLs from atom:link elements", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
          <channel>
            <title>WebSub Feed</title>
            <link>https://example.com</link>
            <atom:link href="https://pubsubhubbub.appspot.com" rel="hub"/>
            <atom:link href="https://example.com/feed.xml" rel="self" type="application/rss+xml"/>
          </channel>
        </rss>`;

      const result = await parseRssStream(stringToStream(xml));

      expect(result.hubUrl).toBe("https://pubsubhubbub.appspot.com");
      expect(result.selfUrl).toBe("https://example.com/feed.xml");
    });
  });

  describe("TTL element", () => {
    it("parses ttl element as minutes", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Feed with TTL</title>
            <ttl>60</ttl>
          </channel>
        </rss>`;

      const result = await parseRssStream(stringToStream(xml));

      expect(result.ttlMinutes).toBe(60);
    });
  });

  describe("Syndication namespace", () => {
    it("parses sy:updatePeriod and sy:updateFrequency", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:sy="http://purl.org/rss/1.0/modules/syndication/">
          <channel>
            <title>Syndication Feed</title>
            <sy:updatePeriod>daily</sy:updatePeriod>
            <sy:updateFrequency>2</sy:updateFrequency>
          </channel>
        </rss>`;

      const result = await parseRssStream(stringToStream(xml));

      expect(result.syndication).toEqual({
        updatePeriod: "daily",
        updateFrequency: 2,
      });
    });
  });

  describe("RSS 1.0 / RDF feed support", () => {
    it("parses RSS 1.0 with dc:date", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                 xmlns="http://purl.org/rss/1.0/"
                 xmlns:dc="http://purl.org/dc/elements/1.1/">
          <channel>
            <title>RSS 1.0 Feed</title>
            <link>https://example.com</link>
          </channel>
          <item>
            <title>Post with dc:date</title>
            <link>https://example.com/post-1</link>
            <dc:date>2010-12-19T00:00:00Z</dc:date>
          </item>
        </rdf:RDF>`;

      const result = await parseRssStream(stringToStream(xml));
      const entries = await collectEntries(result.entries);

      expect(entries).toHaveLength(1);
      expect(entries[0].title).toBe("Post with dc:date");
      expect(entries[0].pubDate).toEqual(new Date("2010-12-19T00:00:00Z"));
    });
  });

  describe("HTML entity decoding", () => {
    it("decodes HTML entities in titles", async () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Flameeyes&#039;s Weblog</title>
            <item>
              <title>Comment by Flameeyes&#039;s Friend</title>
              <link>https://example.com/post</link>
            </item>
          </channel>
        </rss>`;

      const result = await parseRssStream(stringToStream(xml));

      expect(result.title).toBe("Flameeyes's Weblog");
      const entries = await collectEntries(result.entries);
      expect(entries[0].title).toBe("Comment by Flameeyes's Friend");
    });
  });
});
