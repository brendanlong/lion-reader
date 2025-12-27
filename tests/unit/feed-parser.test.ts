/**
 * Unit tests for unified feed parser with auto-detection.
 */

import { describe, it, expect } from "vitest";
import {
  parseFeed,
  parseFeedWithFormat,
  detectFeedType,
  UnknownFeedFormatError,
} from "../../src/server/feed/parser";

describe("detectFeedType", () => {
  describe("RSS detection", () => {
    it("detects RSS 2.0 feed", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Test Feed</title>
          </channel>
        </rss>`;

      expect(detectFeedType(xml)).toBe("rss");
    });

    it("detects RSS 1.0 (RDF) feed", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                 xmlns="http://purl.org/rss/1.0/">
          <channel>
            <title>Test Feed</title>
          </channel>
        </rdf:RDF>`;

      expect(detectFeedType(xml)).toBe("rss");
    });

    it("detects feed with channel element only", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <channel>
          <title>Test Feed</title>
        </channel>`;

      expect(detectFeedType(xml)).toBe("rss");
    });

    it("is case-insensitive for RSS detection", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <RSS version="2.0">
          <channel>
            <title>Test Feed</title>
          </channel>
        </RSS>`;

      expect(detectFeedType(xml)).toBe("rss");
    });
  });

  describe("Atom detection", () => {
    it("detects Atom 1.0 feed", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Test Feed</title>
          <id>urn:uuid:test</id>
          <updated>2024-01-01T00:00:00Z</updated>
        </feed>`;

      expect(detectFeedType(xml)).toBe("atom");
    });

    it("detects Atom feed without namespace", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed>
          <title>Test Feed</title>
        </feed>`;

      expect(detectFeedType(xml)).toBe("atom");
    });

    it("is case-insensitive for Atom detection", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <FEED xmlns="http://www.w3.org/2005/Atom">
          <title>Test Feed</title>
        </FEED>`;

      expect(detectFeedType(xml)).toBe("atom");
    });
  });

  describe("unknown format", () => {
    it("returns unknown for HTML", () => {
      const html = `<!DOCTYPE html>
        <html>
          <head><title>Not a feed</title></head>
          <body></body>
        </html>`;

      expect(detectFeedType(html)).toBe("unknown");
    });

    it("returns unknown for arbitrary XML", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <something>
          <title>Not a feed</title>
        </something>`;

      expect(detectFeedType(xml)).toBe("unknown");
    });

    it("returns unknown for empty string", () => {
      expect(detectFeedType("")).toBe("unknown");
    });

    it("returns unknown for plain text", () => {
      expect(detectFeedType("This is not XML")).toBe("unknown");
    });
  });

  describe("edge cases", () => {
    it("handles whitespace before XML declaration", () => {
      const xml = `
        <?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Test Feed</title>
          </channel>
        </rss>`;

      expect(detectFeedType(xml)).toBe("rss");
    });

    it("handles feed with attributes in element", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
          <title>Test Feed</title>
        </feed>`;

      expect(detectFeedType(xml)).toBe("atom");
    });
  });
});

describe("parseFeed", () => {
  describe("auto-detection and parsing", () => {
    it("parses RSS 2.0 feed automatically", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>RSS Feed</title>
            <link>https://example.com</link>
            <description>An RSS feed</description>
            <item>
              <title>RSS Post</title>
              <link>https://example.com/post</link>
            </item>
          </channel>
        </rss>`;

      const feed = parseFeed(xml);

      expect(feed.title).toBe("RSS Feed");
      expect(feed.siteUrl).toBe("https://example.com");
      expect(feed.description).toBe("An RSS feed");
      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].title).toBe("RSS Post");
    });

    it("parses Atom 1.0 feed automatically", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Atom Feed</title>
          <link href="https://example.com" rel="alternate"/>
          <subtitle>An Atom feed</subtitle>
          <id>urn:uuid:atom-feed</id>
          <updated>2024-01-01T00:00:00Z</updated>
          <entry>
            <title>Atom Post</title>
            <link href="https://example.com/post" rel="alternate"/>
            <id>urn:uuid:atom-post</id>
            <updated>2024-01-01T00:00:00Z</updated>
          </entry>
        </feed>`;

      const feed = parseFeed(xml);

      expect(feed.title).toBe("Atom Feed");
      expect(feed.siteUrl).toBe("https://example.com");
      expect(feed.description).toBe("An Atom feed");
      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].title).toBe("Atom Post");
    });

    it("throws UnknownFeedFormatError for unknown format", () => {
      const html = `<!DOCTYPE html>
        <html>
          <head><title>Not a feed</title></head>
          <body></body>
        </html>`;

      expect(() => parseFeed(html)).toThrow(UnknownFeedFormatError);
      expect(() => parseFeed(html)).toThrow("Unknown feed format");
    });
  });

  describe("unified output format", () => {
    it("produces consistent output for RSS and Atom feeds", () => {
      const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Test Feed</title>
            <link>https://example.com</link>
            <description>Test description</description>
            <item>
              <title>Test Post</title>
              <link>https://example.com/post</link>
              <guid>post-1</guid>
              <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
            </item>
          </channel>
        </rss>`;

      const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Test Feed</title>
          <link href="https://example.com" rel="alternate"/>
          <subtitle>Test description</subtitle>
          <id>urn:uuid:feed</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>Test Post</title>
            <link href="https://example.com/post" rel="alternate"/>
            <id>post-1</id>
            <published>2024-01-01T12:00:00Z</published>
            <updated>2024-01-01T12:00:00Z</updated>
          </entry>
        </feed>`;

      const rssFeed = parseFeed(rssXml);
      const atomFeed = parseFeed(atomXml);

      // Both should have same structure
      expect(rssFeed.title).toBe(atomFeed.title);
      expect(rssFeed.siteUrl).toBe(atomFeed.siteUrl);
      expect(rssFeed.description).toBe(atomFeed.description);
      expect(rssFeed.items).toHaveLength(atomFeed.items.length);
      expect(rssFeed.items[0].title).toBe(atomFeed.items[0].title);
      expect(rssFeed.items[0].link).toBe(atomFeed.items[0].link);
      expect(rssFeed.items[0].guid).toBe(atomFeed.items[0].guid);
      expect(rssFeed.items[0].pubDate).toEqual(atomFeed.items[0].pubDate);
    });
  });
});

describe("parseFeedWithFormat", () => {
  it("parses RSS feed with explicit format", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>RSS Feed</title>
        </channel>
      </rss>`;

    const feed = parseFeedWithFormat(xml, "rss");

    expect(feed.title).toBe("RSS Feed");
  });

  it("parses Atom feed with explicit format", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom Feed</title>
        <id>urn:uuid:atom</id>
        <updated>2024-01-01T00:00:00Z</updated>
      </feed>`;

    const feed = parseFeedWithFormat(xml, "atom");

    expect(feed.title).toBe("Atom Feed");
  });

  it("throws when format doesn't match content (RSS)", () => {
    const atomXml = `<?xml version="1.0" encoding="UTF-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>Atom Feed</title>
      </feed>`;

    // Trying to parse Atom as RSS should fail
    expect(() => parseFeedWithFormat(atomXml, "rss")).toThrow();
  });

  it("throws when format doesn't match content (Atom)", () => {
    const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
      <rss version="2.0">
        <channel>
          <title>RSS Feed</title>
        </channel>
      </rss>`;

    // Trying to parse RSS as Atom should fail
    expect(() => parseFeedWithFormat(rssXml, "atom")).toThrow();
  });
});

describe("UnknownFeedFormatError", () => {
  it("has correct name and message", () => {
    const error = new UnknownFeedFormatError();

    expect(error.name).toBe("UnknownFeedFormatError");
    expect(error.message).toBe("Unknown feed format: unable to detect RSS or Atom");
  });

  it("accepts custom message", () => {
    const error = new UnknownFeedFormatError("Custom error message");

    expect(error.message).toBe("Custom error message");
  });

  it("is instanceof Error", () => {
    const error = new UnknownFeedFormatError();

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(UnknownFeedFormatError);
  });
});
