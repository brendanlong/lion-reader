/**
 * Unit tests for Atom 1.0 feed parser.
 */

import { describe, it, expect } from "vitest";
import { parseAtomFeed, parseAtomDate } from "../../src/server/feed/atom-parser";

describe("parseAtomFeed", () => {
  describe("standard Atom 1.0 feed", () => {
    it("parses a standard Atom 1.0 feed with all elements", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Example Feed</title>
          <subtitle>An example Atom feed</subtitle>
          <link href="https://example.com" rel="alternate"/>
          <link href="https://example.com/feed.xml" rel="self"/>
          <icon>https://example.com/favicon.ico</icon>
          <id>urn:uuid:60a76c80-d399-11d9-b93C-0003939e0af6</id>
          <updated>2024-01-02T12:00:00Z</updated>
          <entry>
            <title>First Post</title>
            <link href="https://example.com/post-1" rel="alternate"/>
            <id>urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a</id>
            <published>2024-01-01T12:00:00Z</published>
            <updated>2024-01-01T12:00:00Z</updated>
            <summary>This is the first post summary</summary>
            <content type="html">&lt;p&gt;This is the full content.&lt;/p&gt;</content>
            <author>
              <name>John Doe</name>
              <email>john@example.com</email>
            </author>
          </entry>
          <entry>
            <title>Second Post</title>
            <link href="https://example.com/post-2" rel="alternate"/>
            <id>urn:uuid:1225c695-cfb8-4ebb-bbbb-80da344efa6b</id>
            <published>2024-01-02T12:00:00Z</published>
            <updated>2024-01-02T12:00:00Z</updated>
            <summary>This is the second post summary</summary>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.title).toBe("Example Feed");
      expect(feed.description).toBe("An example Atom feed");
      expect(feed.siteUrl).toBe("https://example.com");
      expect(feed.iconUrl).toBe("https://example.com/favicon.ico");
      expect(feed.selfUrl).toBe("https://example.com/feed.xml");
      expect(feed.items).toHaveLength(2);

      expect(feed.items[0].title).toBe("First Post");
      expect(feed.items[0].link).toBe("https://example.com/post-1");
      expect(feed.items[0].guid).toBe("urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a");
      expect(feed.items[0].author).toBe("John Doe");
      expect(feed.items[0].summary).toBe("This is the first post summary");
      expect(feed.items[0].content).toBe("<p>This is the full content.</p>");
      expect(feed.items[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));

      expect(feed.items[1].title).toBe("Second Post");
      expect(feed.items[1].pubDate).toEqual(new Date("2024-01-02T12:00:00Z"));
    });

    it("handles a single entry (not an array)", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Single Entry Feed</title>
          <link href="https://example.com" rel="alternate"/>
          <id>urn:uuid:feed-id</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>Only Post</title>
            <link href="https://example.com/only" rel="alternate"/>
            <id>urn:uuid:entry-id</id>
            <updated>2024-01-01T12:00:00Z</updated>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].title).toBe("Only Post");
    });
  });

  describe("feed with missing optional fields", () => {
    it("parses feed with minimal required elements", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Minimal Feed</title>
          <id>urn:uuid:minimal-feed</id>
          <updated>2024-01-01T12:00:00Z</updated>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.title).toBe("Minimal Feed");
      expect(feed.description).toBeUndefined();
      expect(feed.siteUrl).toBeUndefined();
      expect(feed.iconUrl).toBeUndefined();
      expect(feed.items).toHaveLength(0);
    });

    it("handles entries with missing optional fields", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Feed with sparse entries</title>
          <id>urn:uuid:sparse-feed</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>Minimal Entry</title>
            <id>urn:uuid:minimal-entry</id>
            <updated>2024-01-01T12:00:00Z</updated>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].title).toBe("Minimal Entry");
      expect(feed.items[0].guid).toBe("urn:uuid:minimal-entry");
      expect(feed.items[0].link).toBeUndefined();
      expect(feed.items[0].author).toBeUndefined();
      expect(feed.items[0].content).toBeUndefined();
      expect(feed.items[0].summary).toBeUndefined();
      // updated is used as fallback for pubDate
      expect(feed.items[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));
    });

    it("throws error for feed without title", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <subtitle>No title here</subtitle>
          <id>urn:uuid:no-title</id>
          <updated>2024-01-01T12:00:00Z</updated>
        </feed>`;

      expect(() => parseAtomFeed(xml)).toThrow("Invalid Atom feed: missing title");
    });

    it("throws error for missing feed element", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <notafeed>
          <title>Not a feed</title>
        </notafeed>`;

      expect(() => parseAtomFeed(xml)).toThrow("Invalid Atom feed: missing feed element");
    });
  });

  describe("content vs summary handling", () => {
    it("prefers content over summary for content field", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Content Priority Feed</title>
          <id>urn:uuid:content-priority</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>Post with both</title>
            <id>urn:uuid:entry-both</id>
            <updated>2024-01-01T12:00:00Z</updated>
            <summary>Short summary</summary>
            <content type="html">&lt;p&gt;Full content with HTML&lt;/p&gt;</content>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.items[0].content).toBe("<p>Full content with HTML</p>");
      expect(feed.items[0].summary).toBe("Short summary");
    });

    it("falls back to summary when content is not present", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Summary Only Feed</title>
          <id>urn:uuid:summary-only</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>Post with summary only</title>
            <id>urn:uuid:entry-summary</id>
            <updated>2024-01-01T12:00:00Z</updated>
            <summary>This is both content and summary</summary>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.items[0].content).toBe("This is both content and summary");
      expect(feed.items[0].summary).toBe("This is both content and summary");
    });
  });

  describe("content type handling", () => {
    it("handles text type content", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Text Content Feed</title>
          <id>urn:uuid:text-content</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>Text Entry</title>
            <id>urn:uuid:text-entry</id>
            <updated>2024-01-01T12:00:00Z</updated>
            <content type="text">Plain text content</content>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.items[0].content).toBe("Plain text content");
    });

    it("handles html type content with entities", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>HTML Content Feed</title>
          <id>urn:uuid:html-content</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>HTML Entry</title>
            <id>urn:uuid:html-entry</id>
            <updated>2024-01-01T12:00:00Z</updated>
            <content type="html">&lt;p&gt;HTML &amp; entities&lt;/p&gt;</content>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.items[0].content).toBe("<p>HTML & entities</p>");
    });

    it("handles html content in CDATA", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>CDATA Content Feed</title>
          <id>urn:uuid:cdata-content</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>CDATA Entry</title>
            <id>urn:uuid:cdata-entry</id>
            <updated>2024-01-01T12:00:00Z</updated>
            <content type="html"><![CDATA[<p>HTML in CDATA</p>]]></content>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.items[0].content).toBe("<p>HTML in CDATA</p>");
    });
  });

  describe("link relation handling", () => {
    it("extracts alternate link as the main link", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Link Relations Feed</title>
          <link href="https://example.com/feed.xml" rel="self"/>
          <link href="https://example.com" rel="alternate"/>
          <id>urn:uuid:link-relations</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>Entry with links</title>
            <link href="https://example.com/post/edit" rel="edit"/>
            <link href="https://example.com/post" rel="alternate"/>
            <id>urn:uuid:entry-links</id>
            <updated>2024-01-01T12:00:00Z</updated>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.siteUrl).toBe("https://example.com");
      expect(feed.items[0].link).toBe("https://example.com/post");
    });

    it("uses link without rel as alternate (default)", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Default Link Feed</title>
          <link href="https://example.com"/>
          <id>urn:uuid:default-link</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>Entry with default link</title>
            <link href="https://example.com/post"/>
            <id>urn:uuid:entry-default</id>
            <updated>2024-01-01T12:00:00Z</updated>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.siteUrl).toBe("https://example.com");
      expect(feed.items[0].link).toBe("https://example.com/post");
    });
  });

  describe("WebSub discovery", () => {
    it("extracts hub and self URLs from link elements", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>WebSub Feed</title>
          <link href="https://example.com" rel="alternate"/>
          <link href="https://pubsubhubbub.appspot.com" rel="hub"/>
          <link href="https://example.com/feed.xml" rel="self" type="application/atom+xml"/>
          <id>urn:uuid:websub-feed</id>
          <updated>2024-01-01T12:00:00Z</updated>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.hubUrl).toBe("https://pubsubhubbub.appspot.com");
      expect(feed.selfUrl).toBe("https://example.com/feed.xml");
    });

    it("handles missing WebSub links", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>No WebSub Feed</title>
          <link href="https://example.com" rel="alternate"/>
          <id>urn:uuid:no-websub</id>
          <updated>2024-01-01T12:00:00Z</updated>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.hubUrl).toBeUndefined();
      expect(feed.selfUrl).toBeUndefined();
    });
  });

  describe("author handling", () => {
    it("extracts author name from author element", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Author Feed</title>
          <id>urn:uuid:author-feed</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>Post with author</title>
            <id>urn:uuid:entry-author</id>
            <updated>2024-01-01T12:00:00Z</updated>
            <author>
              <name>Jane Doe</name>
              <email>jane@example.com</email>
              <uri>https://example.com/jane</uri>
            </author>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.items[0].author).toBe("Jane Doe");
    });

    it("handles multiple authors (uses first)", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Multi-Author Feed</title>
          <id>urn:uuid:multi-author</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>Post with multiple authors</title>
            <id>urn:uuid:entry-multi-author</id>
            <updated>2024-01-01T12:00:00Z</updated>
            <author>
              <name>First Author</name>
            </author>
            <author>
              <name>Second Author</name>
            </author>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.items[0].author).toBe("First Author");
    });
  });

  describe("date handling", () => {
    it("prefers published over updated for pubDate", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Date Priority Feed</title>
          <id>urn:uuid:date-priority</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>Entry with both dates</title>
            <id>urn:uuid:entry-dates</id>
            <published>2024-01-01T10:00:00Z</published>
            <updated>2024-01-02T12:00:00Z</updated>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.items[0].pubDate).toEqual(new Date("2024-01-01T10:00:00Z"));
    });

    it("falls back to updated when published is missing", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Updated Only Feed</title>
          <id>urn:uuid:updated-only</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>Entry with updated only</title>
            <id>urn:uuid:entry-updated</id>
            <updated>2024-01-02T12:00:00Z</updated>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.items[0].pubDate).toEqual(new Date("2024-01-02T12:00:00Z"));
    });
  });

  describe("icon and logo handling", () => {
    it("prefers icon over logo", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Icons Feed</title>
          <icon>https://example.com/favicon.ico</icon>
          <logo>https://example.com/logo.png</logo>
          <id>urn:uuid:icons</id>
          <updated>2024-01-01T12:00:00Z</updated>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.iconUrl).toBe("https://example.com/favicon.ico");
    });

    it("falls back to logo when icon is missing", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>Logo Only Feed</title>
          <logo>https://example.com/logo.png</logo>
          <id>urn:uuid:logo-only</id>
          <updated>2024-01-01T12:00:00Z</updated>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.iconUrl).toBe("https://example.com/logo.png");
    });
  });

  describe("CDATA handling", () => {
    it("extracts content from CDATA sections in title", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title><![CDATA[CDATA Title Feed]]></title>
          <id>urn:uuid:cdata-title</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title><![CDATA[Post with <Special> Characters]]></title>
            <id>urn:uuid:entry-cdata</id>
            <updated>2024-01-01T12:00:00Z</updated>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.title).toBe("CDATA Title Feed");
      expect(feed.items[0].title).toBe("Post with <Special> Characters");
    });

    it("extracts id from CDATA section", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <feed xmlns="http://www.w3.org/2005/Atom">
          <title>CDATA ID Feed</title>
          <id>urn:uuid:cdata-id-feed</id>
          <updated>2024-01-01T12:00:00Z</updated>
          <entry>
            <title>Entry</title>
            <id><![CDATA[unique-id-123]]></id>
            <updated>2024-01-01T12:00:00Z</updated>
          </entry>
        </feed>`;

      const feed = parseAtomFeed(xml);

      expect(feed.items[0].guid).toBe("unique-id-123");
    });
  });
});

describe("parseAtomDate", () => {
  describe("RFC 3339 / ISO 8601 format", () => {
    it("parses standard ISO 8601 dates with Z timezone", () => {
      expect(parseAtomDate("2024-01-01T12:00:00Z")).toEqual(new Date("2024-01-01T12:00:00Z"));
    });

    it("parses ISO 8601 with positive timezone offset", () => {
      const date = parseAtomDate("2024-01-01T12:00:00+05:00");
      expect(date).toEqual(new Date("2024-01-01T07:00:00Z"));
    });

    it("parses ISO 8601 with negative timezone offset", () => {
      const date = parseAtomDate("2024-01-01T12:00:00-05:00");
      expect(date).toEqual(new Date("2024-01-01T17:00:00Z"));
    });

    it("parses date without time", () => {
      const date = parseAtomDate("2024-01-01");
      expect(date).toBeDefined();
      // Use UTC methods to avoid timezone issues
      expect(date?.getUTCFullYear()).toBe(2024);
      expect(date?.getUTCMonth()).toBe(0); // January
      expect(date?.getUTCDate()).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("returns undefined for empty string", () => {
      expect(parseAtomDate("")).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(parseAtomDate(undefined)).toBeUndefined();
    });

    it("returns undefined for invalid date string", () => {
      expect(parseAtomDate("not a date")).toBeUndefined();
    });

    it("trims whitespace from date strings", () => {
      expect(parseAtomDate("  2024-01-01T12:00:00Z  ")).toEqual(new Date("2024-01-01T12:00:00Z"));
    });

    it("handles object with #text property", () => {
      expect(parseAtomDate({ "#text": "2024-01-01T12:00:00Z" })).toEqual(
        new Date("2024-01-01T12:00:00Z")
      );
    });
  });
});
