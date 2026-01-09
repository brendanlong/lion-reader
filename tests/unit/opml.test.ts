/**
 * Unit tests for OPML parser and generator.
 */

import { describe, it, expect } from "vitest";
import {
  parseOpml,
  generateOpml,
  isValidOpml,
  OpmlParseError,
  type OpmlSubscription,
} from "../../src/server/feed/opml";

describe("parseOpml", () => {
  describe("basic OPML parsing", () => {
    it("parses a simple OPML with flat feeds", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head>
            <title>My Feeds</title>
          </head>
          <body>
            <outline type="rss" text="Example Blog" xmlUrl="https://example.com/feed.xml" htmlUrl="https://example.com" />
            <outline type="rss" text="Tech News" xmlUrl="https://tech.example.com/rss" />
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds).toHaveLength(2);
      expect(feeds[0]).toEqual({
        title: "Example Blog",
        xmlUrl: "https://example.com/feed.xml",
        htmlUrl: "https://example.com",
      });
      expect(feeds[1]).toEqual({
        title: "Tech News",
        xmlUrl: "https://tech.example.com/rss",
      });
    });

    it("parses OPML with title attribute instead of text", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="1.0">
          <head><title>Feeds</title></head>
          <body>
            <outline type="rss" title="Blog Title" xmlUrl="https://example.com/feed" />
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds).toHaveLength(1);
      expect(feeds[0].title).toBe("Blog Title");
    });

    it("prefers text attribute over title when both present", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Feeds</title></head>
          <body>
            <outline type="rss" text="Text Value" title="Title Value" xmlUrl="https://example.com/feed" />
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds[0].title).toBe("Text Value");
    });

    it("handles feeds without type attribute", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Feeds</title></head>
          <body>
            <outline text="No Type Feed" xmlUrl="https://example.com/feed" />
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds).toHaveLength(1);
      expect(feeds[0].xmlUrl).toBe("https://example.com/feed");
    });
  });

  describe("nested folders/categories", () => {
    it("parses single-level nested folders", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Feeds</title></head>
          <body>
            <outline text="Technology">
              <outline type="rss" text="Tech Blog" xmlUrl="https://tech.example.com/feed" />
              <outline type="rss" text="Dev News" xmlUrl="https://dev.example.com/feed" />
            </outline>
            <outline type="rss" text="Uncategorized" xmlUrl="https://other.example.com/feed" />
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds).toHaveLength(3);
      expect(feeds[0]).toEqual({
        title: "Tech Blog",
        xmlUrl: "https://tech.example.com/feed",
        category: ["Technology"],
      });
      expect(feeds[1]).toEqual({
        title: "Dev News",
        xmlUrl: "https://dev.example.com/feed",
        category: ["Technology"],
      });
      expect(feeds[2]).toEqual({
        title: "Uncategorized",
        xmlUrl: "https://other.example.com/feed",
      });
    });

    it("parses deeply nested folders", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Feeds</title></head>
          <body>
            <outline text="Technology">
              <outline text="Programming">
                <outline text="JavaScript">
                  <outline type="rss" text="JS Weekly" xmlUrl="https://js.example.com/feed" />
                </outline>
              </outline>
            </outline>
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds).toHaveLength(1);
      expect(feeds[0].category).toEqual(["Technology", "Programming", "JavaScript"]);
    });

    it("handles multiple folders at the same level", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Feeds</title></head>
          <body>
            <outline text="News">
              <outline type="rss" text="World News" xmlUrl="https://news1.example.com/feed" />
            </outline>
            <outline text="Sports">
              <outline type="rss" text="Sports News" xmlUrl="https://sports.example.com/feed" />
            </outline>
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds).toHaveLength(2);
      expect(feeds[0].category).toEqual(["News"]);
      expect(feeds[1].category).toEqual(["Sports"]);
    });

    it("handles category attribute on feed outline", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Feeds</title></head>
          <body>
            <outline type="rss" text="Blog" xmlUrl="https://example.com/feed" category="Tech" />
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds[0].category).toEqual(["Tech"]);
    });

    it("handles slash-separated category paths in attribute", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Feeds</title></head>
          <body>
            <outline type="rss" text="Blog" xmlUrl="https://example.com/feed" category="Tech/Programming" />
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds[0].category).toEqual(["Tech", "Programming"]);
    });

    it("prefers folder nesting over category attribute", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Feeds</title></head>
          <body>
            <outline text="Folder">
              <outline type="rss" text="Blog" xmlUrl="https://example.com/feed" category="Other" />
            </outline>
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds[0].category).toEqual(["Folder"]);
    });
  });

  describe("edge cases", () => {
    it("returns empty array for OPML with no feeds", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Empty</title></head>
          <body></body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds).toHaveLength(0);
    });

    it("returns empty array for OPML with only empty folders", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Empty Folders</title></head>
          <body>
            <outline text="Empty Folder"></outline>
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds).toHaveLength(0);
    });

    it("handles OPML with single outline (not array)", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Single</title></head>
          <body>
            <outline type="rss" text="Only Feed" xmlUrl="https://example.com/feed" />
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds).toHaveLength(1);
    });

    it("ignores outlines without xmlUrl that are not folders", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Mixed</title></head>
          <body>
            <outline text="Just Text" />
            <outline type="rss" text="Valid Feed" xmlUrl="https://example.com/feed" />
            <outline type="link" text="A Link" url="https://example.com" />
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds).toHaveLength(1);
      expect(feeds[0].title).toBe("Valid Feed");
    });

    it("handles feeds with missing title", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>No Title</title></head>
          <body>
            <outline type="rss" xmlUrl="https://example.com/feed" />
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds).toHaveLength(1);
      expect(feeds[0].title).toBeUndefined();
      expect(feeds[0].xmlUrl).toBe("https://example.com/feed");
    });

    it("handles CDATA in text content", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title><![CDATA[My Feeds]]></title></head>
          <body>
            <outline type="rss" text="Blog &amp; News" xmlUrl="https://example.com/feed" />
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds[0].title).toBe("Blog & News");
    });
  });

  describe("error handling", () => {
    it("throws OpmlParseError for invalid XML", () => {
      const xml = "not valid xml at all <>";

      expect(() => parseOpml(xml)).toThrow(OpmlParseError);
    });

    it("throws OpmlParseError for missing opml element", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
          <channel><title>Not OPML</title></channel>
        </rss>`;

      expect(() => parseOpml(xml)).toThrow("Invalid OPML: missing opml element");
    });

    it("throws OpmlParseError for missing body element", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>No Body</title></head>
        </opml>`;

      expect(() => parseOpml(xml)).toThrow("Invalid OPML: missing body element");
    });
  });

  describe("real-world OPML examples", () => {
    it("parses Feedly-style OPML export", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="1.0">
          <head>
            <title>Feedly subscriptions</title>
          </head>
          <body>
            <outline text="tech" title="tech">
              <outline type="rss" text="Hacker News" title="Hacker News" xmlUrl="https://news.ycombinator.com/rss" htmlUrl="https://news.ycombinator.com/"/>
              <outline type="rss" text="TechCrunch" title="TechCrunch" xmlUrl="https://techcrunch.com/feed/" htmlUrl="https://techcrunch.com"/>
            </outline>
            <outline type="rss" text="xkcd" title="xkcd" xmlUrl="https://xkcd.com/rss.xml" htmlUrl="https://xkcd.com/"/>
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds).toHaveLength(3);
      expect(feeds[0].category).toEqual(["tech"]);
      expect(feeds[1].category).toEqual(["tech"]);
      expect(feeds[2].category).toBeUndefined();
    });

    it("parses Inoreader-style OPML export", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="1.0">
          <head>
            <title>Inoreader Subscriptions</title>
            <dateCreated>Mon, 01 Jan 2024 00:00:00 +0000</dateCreated>
          </head>
          <body>
            <outline text="Blogs" title="Blogs">
              <outline text="Personal" title="Personal">
                <outline type="rss" text="Paul Graham" title="Paul Graham" xmlUrl="http://www.paulgraham.com/rss.html" htmlUrl="http://www.paulgraham.com/articles.html"/>
              </outline>
            </outline>
          </body>
        </opml>`;

      const feeds = parseOpml(xml);

      expect(feeds).toHaveLength(1);
      expect(feeds[0].category).toEqual(["Blogs", "Personal"]);
      expect(feeds[0].title).toBe("Paul Graham");
    });
  });
});

describe("generateOpml", () => {
  describe("basic generation", () => {
    it("generates valid OPML for flat subscriptions", () => {
      const subscriptions: OpmlSubscription[] = [
        { title: "Blog One", xmlUrl: "https://blog1.example.com/feed" },
        {
          title: "Blog Two",
          xmlUrl: "https://blog2.example.com/feed",
          htmlUrl: "https://blog2.example.com",
        },
      ];

      const xml = generateOpml(subscriptions);

      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(xml).toContain('<opml version="2.0">');
      expect(xml).toContain('text="Blog One"');
      expect(xml).toContain('xmlUrl="https://blog1.example.com/feed"');
      expect(xml).toContain('htmlUrl="https://blog2.example.com"');
    });

    it("generates OPML with tags format (feeds at top level + in tag folders)", () => {
      const subscriptions: OpmlSubscription[] = [
        {
          title: "Tech Blog",
          xmlUrl: "https://tech.example.com/feed",
          tags: ["Tech", "Favorites"],
        },
        { title: "News Site", xmlUrl: "https://news.example.com/feed", tags: ["News"] },
        { title: "Ungrouped", xmlUrl: "https://other.example.com/feed", tags: [] },
      ];

      const xml = generateOpml(subscriptions);

      // All feeds should appear at top level
      const topLevelMatches = xml.match(/<outline type="rss"/g);
      // 3 at top level + 1 in Favorites + 1 in News + 1 in Tech = 6
      expect(topLevelMatches).toHaveLength(6);

      // Tag folders should exist
      expect(xml).toContain('text="Favorites"');
      expect(xml).toContain('text="News"');
      expect(xml).toContain('text="Tech"');
    });

    it("generates OPML with feed in multiple tags appearing in each folder", () => {
      const subscriptions: OpmlSubscription[] = [
        {
          title: "Multi-tag Feed",
          xmlUrl: "https://multi.example.com/feed",
          tags: ["Tag1", "Tag2", "Tag3"],
        },
      ];

      const xml = generateOpml(subscriptions);
      const parsed = parseOpml(xml);

      // Feed appears 4 times: 1 at top level + 3 in tag folders
      expect(parsed).toHaveLength(4);

      // 1 at top level (no category)
      const uncategorized = parsed.filter((f) => !f.category);
      expect(uncategorized).toHaveLength(1);

      // 3 in folders
      const categorized = parsed.filter((f) => f.category);
      expect(categorized).toHaveLength(3);

      // Verify categories
      const categories = categorized.map((f) => f.category![0]).sort();
      expect(categories).toEqual(["Tag1", "Tag2", "Tag3"]);
    });

    it("generates valid OPML with metadata", () => {
      const subscriptions: OpmlSubscription[] = [
        { title: "Blog", xmlUrl: "https://example.com/feed" },
      ];
      const metadata = {
        title: "My Subscriptions",
        ownerName: "John Doe",
        ownerEmail: "john@example.com",
      };

      const xml = generateOpml(subscriptions, metadata);

      expect(xml).toContain("<title>My Subscriptions</title>");
      expect(xml).toContain("<ownerName>John Doe</ownerName>");
      expect(xml).toContain("<ownerEmail>john@example.com</ownerEmail>");
    });

    it("uses default title when not provided", () => {
      const subscriptions: OpmlSubscription[] = [];

      const xml = generateOpml(subscriptions);

      expect(xml).toContain("<title>Lion Reader Subscriptions</title>");
    });
  });

  describe("folder grouping", () => {
    it("groups subscriptions by folder", () => {
      const subscriptions: OpmlSubscription[] = [
        { title: "Tech Blog", xmlUrl: "https://tech.example.com/feed", folder: "Technology" },
        { title: "News Site", xmlUrl: "https://news.example.com/feed", folder: "News" },
        { title: "Ungrouped", xmlUrl: "https://other.example.com/feed" },
      ];

      const xml = generateOpml(subscriptions);

      // Should have folder outlines
      expect(xml).toContain('text="Technology"');
      expect(xml).toContain('text="News"');
      // Ungrouped should be at top level
      expect(xml).toMatch(/<outline type="rss" text="Ungrouped"/);
    });

    it("places multiple feeds in the same folder", () => {
      const subscriptions: OpmlSubscription[] = [
        { title: "Blog 1", xmlUrl: "https://blog1.example.com/feed", folder: "Blogs" },
        { title: "Blog 2", xmlUrl: "https://blog2.example.com/feed", folder: "Blogs" },
      ];

      const xml = generateOpml(subscriptions);

      // Count occurrences of Blogs folder - should only appear once
      const folderMatches = xml.match(/text="Blogs">/g);
      expect(folderMatches).toHaveLength(1);

      // Both blogs should be inside
      expect(xml).toContain('text="Blog 1"');
      expect(xml).toContain('text="Blog 2"');
    });
  });

  describe("XML escaping", () => {
    it("escapes special XML characters in titles", () => {
      const subscriptions: OpmlSubscription[] = [
        { title: 'Blog & "News" <Test>', xmlUrl: "https://example.com/feed" },
      ];

      const xml = generateOpml(subscriptions);

      expect(xml).toContain("Blog &amp; &quot;News&quot; &lt;Test&gt;");
    });

    it("escapes special characters in URLs", () => {
      const subscriptions: OpmlSubscription[] = [
        { title: "Blog", xmlUrl: "https://example.com/feed?a=1&b=2" },
      ];

      const xml = generateOpml(subscriptions);

      expect(xml).toContain("https://example.com/feed?a=1&amp;b=2");
    });

    it("escapes special characters in folder names", () => {
      const subscriptions: OpmlSubscription[] = [
        { title: "Blog", xmlUrl: "https://example.com/feed", folder: "Tech & News" },
      ];

      const xml = generateOpml(subscriptions);

      expect(xml).toContain('text="Tech &amp; News"');
    });
  });

  describe("round-trip", () => {
    it("generated OPML can be parsed back", () => {
      const subscriptions: OpmlSubscription[] = [
        {
          title: "Blog One",
          xmlUrl: "https://blog1.example.com/feed",
          htmlUrl: "https://blog1.example.com",
        },
        { title: "Blog Two", xmlUrl: "https://blog2.example.com/feed", folder: "Tech" },
      ];

      const xml = generateOpml(subscriptions, { title: "Test Export" });
      const parsed = parseOpml(xml);

      expect(parsed).toHaveLength(2);
      expect(parsed[0].title).toBe("Blog One");
      expect(parsed[0].xmlUrl).toBe("https://blog1.example.com/feed");
      expect(parsed[0].htmlUrl).toBe("https://blog1.example.com");
      expect(parsed[1].title).toBe("Blog Two");
      expect(parsed[1].category).toEqual(["Tech"]);
    });

    it("preserves folder structure in round-trip", () => {
      const subscriptions: OpmlSubscription[] = [
        { title: "Blog 1", xmlUrl: "https://blog1.example.com/feed", folder: "Category A" },
        { title: "Blog 2", xmlUrl: "https://blog2.example.com/feed", folder: "Category A" },
        { title: "Blog 3", xmlUrl: "https://blog3.example.com/feed", folder: "Category B" },
        { title: "Blog 4", xmlUrl: "https://blog4.example.com/feed" },
      ];

      const xml = generateOpml(subscriptions);
      const parsed = parseOpml(xml);

      expect(parsed).toHaveLength(4);

      // Check category assignments
      const categoryA = parsed.filter((f) => f.category?.includes("Category A"));
      const categoryB = parsed.filter((f) => f.category?.includes("Category B"));
      const uncategorized = parsed.filter((f) => !f.category);

      expect(categoryA).toHaveLength(2);
      expect(categoryB).toHaveLength(1);
      expect(uncategorized).toHaveLength(1);
    });
  });
});

describe("isValidOpml", () => {
  it("returns true for valid OPML", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <opml version="2.0">
        <head><title>Valid</title></head>
        <body></body>
      </opml>`;

    expect(isValidOpml(xml)).toBe(true);
  });

  it("returns false for invalid XML", () => {
    expect(isValidOpml("not xml")).toBe(false);
  });

  it("returns false for non-OPML XML", () => {
    const xml = `<?xml version="1.0"?><rss><channel></channel></rss>`;
    expect(isValidOpml(xml)).toBe(false);
  });

  it("returns false for OPML without body", () => {
    const xml = `<?xml version="1.0"?><opml version="2.0"><head></head></opml>`;
    expect(isValidOpml(xml)).toBe(false);
  });
});
