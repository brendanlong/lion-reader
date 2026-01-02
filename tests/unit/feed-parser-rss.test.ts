/**
 * Unit tests for RSS 2.0 feed parser.
 */

import { describe, it, expect } from "vitest";
import { parseRssFeed, parseRssDate } from "../../src/server/feed/rss-parser";

describe("parseRssFeed", () => {
  describe("standard RSS 2.0 feed", () => {
    it("parses a standard RSS 2.0 feed with all elements", () => {
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

      const feed = parseRssFeed(xml);

      expect(feed.title).toBe("Example Feed");
      expect(feed.siteUrl).toBe("https://example.com");
      expect(feed.description).toBe("An example RSS feed");
      expect(feed.iconUrl).toBe("https://example.com/icon.png");
      expect(feed.items).toHaveLength(2);

      expect(feed.items[0].title).toBe("First Post");
      expect(feed.items[0].link).toBe("https://example.com/post-1");
      expect(feed.items[0].summary).toBe("This is the first post");
      expect(feed.items[0].content).toBe("This is the first post");
      expect(feed.items[0].guid).toBe("https://example.com/post-1");
      expect(feed.items[0].author).toBe("author@example.com");
      expect(feed.items[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));

      expect(feed.items[1].title).toBe("Second Post");
      expect(feed.items[1].pubDate).toEqual(new Date("2024-01-02T12:00:00Z"));
    });

    it("handles a single item (not an array)", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Single Item Feed</title>
            <link>https://example.com</link>
            <item>
              <title>Only Post</title>
              <link>https://example.com/only</link>
            </item>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].title).toBe("Only Post");
    });
  });

  describe("feed with missing optional fields", () => {
    it("parses feed with minimal required elements", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Minimal Feed</title>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.title).toBe("Minimal Feed");
      expect(feed.description).toBeUndefined();
      expect(feed.siteUrl).toBeUndefined();
      expect(feed.iconUrl).toBeUndefined();
      expect(feed.items).toHaveLength(0);
    });

    it("handles items with missing optional fields", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Feed with sparse items</title>
            <item>
              <title>Minimal Item</title>
            </item>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].title).toBe("Minimal Item");
      expect(feed.items[0].link).toBeUndefined();
      expect(feed.items[0].guid).toBeUndefined();
      expect(feed.items[0].author).toBeUndefined();
      expect(feed.items[0].content).toBeUndefined();
      expect(feed.items[0].summary).toBeUndefined();
      expect(feed.items[0].pubDate).toBeUndefined();
    });

    it("throws error for feed without title", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <description>No title here</description>
          </channel>
        </rss>`;

      expect(() => parseRssFeed(xml)).toThrow("Invalid RSS feed: missing title");
    });

    it("throws error for feed without channel", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
        </rss>`;

      expect(() => parseRssFeed(xml)).toThrow("Invalid RSS feed: missing channel element");
    });
  });

  describe("feed with content:encoded", () => {
    it("prefers content:encoded over description for content", () => {
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

      const feed = parseRssFeed(xml);

      expect(feed.items[0].content).toBe(
        "<p>This is the <strong>full content</strong> with HTML.</p>"
      );
      expect(feed.items[0].summary).toBe("Short summary of the post");
    });

    it("falls back to description when content:encoded is not present", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Description Only Feed</title>
            <item>
              <title>Simple Post</title>
              <description>This is both content and summary</description>
            </item>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.items[0].content).toBe("This is both content and summary");
      expect(feed.items[0].summary).toBe("This is both content and summary");
    });
  });

  describe("feed with dc:creator author", () => {
    it("extracts author from dc:creator", () => {
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

      const feed = parseRssFeed(xml);

      expect(feed.items[0].author).toBe("John Doe");
    });

    it("prefers dc:creator over author element", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
          <channel>
            <title>Mixed Author Feed</title>
            <item>
              <title>Post with Both</title>
              <author>email@example.com</author>
              <dc:creator>John Doe</dc:creator>
            </item>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.items[0].author).toBe("John Doe");
    });

    it("falls back to author when dc:creator is not present", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Author Only Feed</title>
            <item>
              <title>Post with Author</title>
              <author>author@example.com (Jane Doe)</author>
            </item>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.items[0].author).toBe("author@example.com (Jane Doe)");
    });
  });

  describe("CDATA content handling", () => {
    it("extracts content from CDATA sections in title", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title><![CDATA[CDATA Title Feed]]></title>
            <item>
              <title><![CDATA[Post with <Special> Characters]]></title>
            </item>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.title).toBe("CDATA Title Feed");
      expect(feed.items[0].title).toBe("Post with <Special> Characters");
    });

    it("extracts content from CDATA sections in description", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>CDATA Description Feed</title>
            <description><![CDATA[<p>HTML in description</p>]]></description>
            <item>
              <title>Post</title>
              <description><![CDATA[<p>HTML content</p>]]></description>
            </item>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.description).toBe("<p>HTML in description</p>");
      expect(feed.items[0].summary).toBe("<p>HTML content</p>");
    });

    it("handles CDATA in guid element", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>CDATA GUID Feed</title>
            <item>
              <title>Post</title>
              <guid><![CDATA[unique-id-123]]></guid>
            </item>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.items[0].guid).toBe("unique-id-123");
    });
  });

  describe("guid element variations", () => {
    it("parses simple guid string", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>Simple GUID Feed</title>
            <item>
              <title>Post</title>
              <guid>https://example.com/post-1</guid>
            </item>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.items[0].guid).toBe("https://example.com/post-1");
    });

    it("parses guid with isPermaLink attribute", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>PermaLink GUID Feed</title>
            <item>
              <title>Post</title>
              <guid isPermaLink="false">unique-id-12345</guid>
            </item>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.items[0].guid).toBe("unique-id-12345");
    });
  });

  describe("WebSub discovery", () => {
    it("extracts hub and self URLs from atom:link elements", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
          <channel>
            <title>WebSub Feed</title>
            <link>https://example.com</link>
            <atom:link href="https://pubsubhubbub.appspot.com" rel="hub"/>
            <atom:link href="https://example.com/feed.xml" rel="self" type="application/rss+xml"/>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.hubUrl).toBe("https://pubsubhubbub.appspot.com");
      expect(feed.selfUrl).toBe("https://example.com/feed.xml");
    });

    it("handles missing WebSub links", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel>
            <title>No WebSub Feed</title>
            <link>https://example.com</link>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.hubUrl).toBeUndefined();
      expect(feed.selfUrl).toBeUndefined();
    });
  });

  describe("RSS 1.0 / RDF feed support", () => {
    it("parses dc:date in RSS 1.0 items", () => {
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

      const feed = parseRssFeed(xml);

      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].title).toBe("Post with dc:date");
      expect(feed.items[0].pubDate).toEqual(new Date("2010-12-19T00:00:00Z"));
    });

    it("prefers pubDate over dc:date when both are present", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
          <channel>
            <title>Mixed Date Feed</title>
            <item>
              <title>Post with both dates</title>
              <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
              <dc:date>2010-12-19T00:00:00Z</dc:date>
            </item>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.items[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));
    });

    it("falls back to dc:date when pubDate is missing", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
          <channel>
            <title>DC Date Only Feed</title>
            <item>
              <title>Post with dc:date only</title>
              <dc:date>2015-06-15T10:30:00Z</dc:date>
            </item>
          </channel>
        </rss>`;

      const feed = parseRssFeed(xml);

      expect(feed.items[0].pubDate).toEqual(new Date("2015-06-15T10:30:00Z"));
    });
  });
});

describe("parseRssDate", () => {
  describe("RFC 2822 format", () => {
    it("parses standard RFC 2822 dates", () => {
      expect(parseRssDate("Mon, 01 Jan 2024 12:00:00 GMT")).toEqual(
        new Date("2024-01-01T12:00:00Z")
      );
    });

    it("parses RFC 2822 with timezone offset", () => {
      const date = parseRssDate("Mon, 01 Jan 2024 12:00:00 +0000");
      expect(date).toEqual(new Date("2024-01-01T12:00:00Z"));
    });

    it("parses RFC 2822 with negative timezone offset", () => {
      const date = parseRssDate("Mon, 01 Jan 2024 12:00:00 -0500");
      expect(date).toEqual(new Date("2024-01-01T17:00:00Z"));
    });
  });

  describe("ISO 8601 format", () => {
    it("parses ISO 8601 dates", () => {
      expect(parseRssDate("2024-01-01T12:00:00Z")).toEqual(new Date("2024-01-01T12:00:00Z"));
    });

    it("parses ISO 8601 with timezone offset", () => {
      expect(parseRssDate("2024-01-01T12:00:00+00:00")).toEqual(new Date("2024-01-01T12:00:00Z"));
    });
  });

  describe("common timezone abbreviations", () => {
    it("parses dates with EST timezone", () => {
      const date = parseRssDate("Mon, 01 Jan 2024 12:00:00 EST");
      expect(date).toEqual(new Date("2024-01-01T17:00:00Z"));
    });

    it("parses dates with PST timezone", () => {
      const date = parseRssDate("Mon, 01 Jan 2024 12:00:00 PST");
      expect(date).toEqual(new Date("2024-01-01T20:00:00Z"));
    });

    it("parses dates with UTC timezone", () => {
      const date = parseRssDate("Mon, 01 Jan 2024 12:00:00 UTC");
      expect(date).toEqual(new Date("2024-01-01T12:00:00Z"));
    });
  });

  describe("edge cases", () => {
    it("returns undefined for empty string", () => {
      expect(parseRssDate("")).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(parseRssDate(undefined)).toBeUndefined();
    });

    it("returns undefined for invalid date string", () => {
      expect(parseRssDate("not a date")).toBeUndefined();
    });

    it("trims whitespace from date strings", () => {
      expect(parseRssDate("  2024-01-01T12:00:00Z  ")).toEqual(new Date("2024-01-01T12:00:00Z"));
    });
  });
});
