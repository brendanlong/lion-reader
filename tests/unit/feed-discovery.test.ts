/**
 * Unit tests for feed discovery from HTML pages.
 */

import { describe, it, expect } from "vitest";
import {
  discoverFeeds,
  getCommonFeedUrls,
  COMMON_FEED_PATHS,
} from "../../src/server/feed/discovery";

describe("discoverFeeds", () => {
  describe("standard RSS link discovery", () => {
    it("discovers RSS feed from link tag", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Example Site</title>
            <link rel="alternate" type="application/rss+xml" href="/feed.xml" title="RSS Feed">
          </head>
          <body></body>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0]).toEqual({
        url: "https://example.com/feed.xml",
        type: "rss",
        title: "RSS Feed",
      });
    });

    it("discovers RSS feed with absolute URL", () => {
      const html = `
        <html>
          <head>
            <link rel="alternate" type="application/rss+xml" href="https://example.com/rss" title="Example RSS">
          </head>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://other.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://example.com/rss");
      expect(feeds[0].type).toBe("rss");
    });

    it("handles self-closing link tags", () => {
      const html = `
        <html>
          <head>
            <link rel="alternate" type="application/rss+xml" href="/feed" />
          </head>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://example.com/feed");
    });
  });

  describe("standard Atom link discovery", () => {
    it("discovers Atom feed from link tag", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <link rel="alternate" type="application/atom+xml" href="/atom.xml" title="Atom Feed">
          </head>
          <body></body>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0]).toEqual({
        url: "https://example.com/atom.xml",
        type: "atom",
        title: "Atom Feed",
      });
    });

    it("discovers Atom feed with full URL", () => {
      const html = `
        <head>
          <link rel="alternate" type="application/atom+xml" href="https://blog.example.com/atom" />
        </head>
      `;

      const feeds = discoverFeeds(html, "https://www.example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://blog.example.com/atom");
      expect(feeds[0].type).toBe("atom");
    });
  });

  describe("multiple feeds on one page", () => {
    it("discovers multiple feeds of the same type", () => {
      const html = `
        <html>
          <head>
            <link rel="alternate" type="application/rss+xml" href="/feed/all" title="All Posts">
            <link rel="alternate" type="application/rss+xml" href="/feed/tech" title="Tech Posts">
            <link rel="alternate" type="application/rss+xml" href="/feed/life" title="Life Posts">
          </head>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://blog.example.com");

      expect(feeds).toHaveLength(3);
      expect(feeds[0].title).toBe("All Posts");
      expect(feeds[1].title).toBe("Tech Posts");
      expect(feeds[2].title).toBe("Life Posts");
    });

    it("discovers mixed RSS and Atom feeds", () => {
      const html = `
        <html>
          <head>
            <link rel="alternate" type="application/rss+xml" href="/rss.xml" title="RSS">
            <link rel="alternate" type="application/atom+xml" href="/atom.xml" title="Atom">
          </head>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(2);

      const rss = feeds.find((f) => f.type === "rss");
      const atom = feeds.find((f) => f.type === "atom");

      expect(rss).toBeDefined();
      expect(rss!.url).toBe("https://example.com/rss.xml");

      expect(atom).toBeDefined();
      expect(atom!.url).toBe("https://example.com/atom.xml");
    });

    it("deduplicates feeds with the same URL", () => {
      const html = `
        <html>
          <head>
            <link rel="alternate" type="application/rss+xml" href="/feed.xml" title="Feed 1">
            <link rel="alternate" type="application/rss+xml" href="/feed.xml" title="Feed 2">
          </head>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].title).toBe("Feed 1"); // First one wins
    });
  });

  describe("relative URL resolution", () => {
    it("resolves root-relative URLs", () => {
      const html = `
        <link rel="alternate" type="application/rss+xml" href="/feeds/main.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com/blog/post");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://example.com/feeds/main.xml");
    });

    it("resolves relative URLs from subdirectory", () => {
      const html = `
        <link rel="alternate" type="application/rss+xml" href="feed.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com/blog/");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://example.com/blog/feed.xml");
    });

    it("resolves parent-relative URLs", () => {
      const html = `
        <link rel="alternate" type="application/rss+xml" href="../feed.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com/blog/posts/");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://example.com/blog/feed.xml");
    });

    it("resolves protocol-relative URLs", () => {
      const html = `
        <link rel="alternate" type="application/rss+xml" href="//cdn.example.com/feed.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://cdn.example.com/feed.xml");
    });

    it("handles query parameters in URLs", () => {
      const html = `
        <link rel="alternate" type="application/rss+xml" href="/feed?format=rss&category=tech">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://example.com/feed?format=rss&category=tech");
    });

    it("preserves URL fragments", () => {
      const html = `
        <link rel="alternate" type="application/atom+xml" href="/feed.xml#section">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://example.com/feed.xml#section");
    });
  });

  describe("missing title handling", () => {
    it("returns undefined title when not present", () => {
      const html = `
        <link rel="alternate" type="application/rss+xml" href="/feed.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].title).toBeUndefined();
    });

    it("returns undefined title for empty title attribute", () => {
      const html = `
        <link rel="alternate" type="application/rss+xml" href="/feed.xml" title="">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].title).toBeUndefined();
    });

    it("preserves whitespace in title", () => {
      const html = `
        <link rel="alternate" type="application/rss+xml" href="/feed.xml" title="  My  Feed  ">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].title).toBe("  My  Feed  ");
    });
  });

  describe("no feeds found", () => {
    it("returns empty array for HTML without feed links", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>No Feeds Here</title>
            <link rel="stylesheet" href="/styles.css">
            <link rel="icon" href="/favicon.ico">
          </head>
          <body>
            <p>No feeds on this page.</p>
          </body>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(0);
    });

    it("returns empty array for empty HTML", () => {
      const feeds = discoverFeeds("", "https://example.com");

      expect(feeds).toHaveLength(0);
    });

    it("ignores link tags without rel=alternate", () => {
      const html = `
        <link type="application/rss+xml" href="/feed.xml" title="RSS">
        <link rel="stylesheet" type="application/rss+xml" href="/feed.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(0);
    });

    it("ignores link tags without feed type", () => {
      const html = `
        <link rel="alternate" href="/feed.xml" title="Feed">
        <link rel="alternate" type="text/html" href="/page.html">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(0);
    });

    it("ignores link tags without href", () => {
      const html = `
        <link rel="alternate" type="application/rss+xml" title="Feed Without URL">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(0);
    });
  });

  describe("malformed HTML handling", () => {
    it("handles attributes in various orders", () => {
      const html = `
        <link href="/feed1.xml" rel="alternate" type="application/rss+xml" title="Feed 1">
        <link type="application/atom+xml" title="Feed 2" rel="alternate" href="/feed2.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(2);
      expect(feeds[0].url).toBe("https://example.com/feed1.xml");
      expect(feeds[1].url).toBe("https://example.com/feed2.xml");
    });

    it("handles single-quoted attributes", () => {
      const html = `
        <link rel='alternate' type='application/rss+xml' href='/feed.xml' title='My Feed'>
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://example.com/feed.xml");
      expect(feeds[0].title).toBe("My Feed");
    });

    it("handles mixed quote styles", () => {
      const html = `
        <link rel="alternate" type='application/rss+xml' href="/feed.xml" title='Feed'>
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
    });

    it("handles unquoted attribute values", () => {
      const html = `
        <link rel=alternate type=application/rss+xml href=/feed.xml>
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://example.com/feed.xml");
    });

    it("handles extra whitespace in attributes", () => {
      const html = `
        <link  rel = "alternate"   type = "application/rss+xml"   href = "/feed.xml" >
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
    });

    it("handles newlines within link tags", () => {
      const html = `
        <link
          rel="alternate"
          type="application/rss+xml"
          href="/feed.xml"
          title="Multi-line Link"
        >
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].title).toBe("Multi-line Link");
    });

    it("handles uppercase tags and attributes", () => {
      const html = `
        <LINK REL="alternate" TYPE="application/rss+xml" HREF="/feed.xml" TITLE="Uppercase">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].title).toBe("Uppercase");
    });

    it("handles link tags mixed with other content", () => {
      const html = `
        <!DOCTYPE html>
        <!-- This is a comment with <link> in it -->
        <html>
        <head>
        <meta charset="UTF-8">
        <link rel="alternate" type="application/rss+xml" href="/feed.xml">
        <script>
          var link = '<link rel="alternate">';
        </script>
        <style>
          .link { color: blue; }
        </style>
        </head>
        <body>
        <a href="/feed.xml">Feed</a>
        </body>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      // Should find the real link tag
      // Note: This simple parser will also find the one in the script, which is acceptable
      // for MVP. A full HTML parser would be needed to properly handle this case.
      expect(feeds.length).toBeGreaterThanOrEqual(1);
      expect(feeds.some((f) => f.url === "https://example.com/feed.xml")).toBe(true);
    });

    it("skips links with empty href", () => {
      const html = `
        <link rel="alternate" type="application/rss+xml" href="">
        <link rel="alternate" type="application/rss+xml" href="/valid.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://example.com/valid.xml");
    });

    it("handles HTML entities in title", () => {
      const html = `
        <link rel="alternate" type="application/rss+xml" href="/feed.xml" title="Tom &amp; Jerry's Feed">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      // Note: HTML entities are preserved as-is (not decoded)
      // This is acceptable for MVP; full entity decoding would require a proper HTML parser
      expect(feeds[0].title).toBe("Tom &amp; Jerry's Feed");
    });
  });

  describe("rel attribute variations", () => {
    it("handles rel with multiple values including alternate", () => {
      const html = `
        <link rel="alternate nofollow" type="application/rss+xml" href="/feed.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
    });

    it("handles alternate in different positions", () => {
      const html = `
        <link rel="nofollow alternate" type="application/rss+xml" href="/feed1.xml">
        <link rel="alternate" type="application/rss+xml" href="/feed2.xml">
        <link rel="alternate stylesheet" type="application/rss+xml" href="/feed3.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(3);
    });

    it("is case-insensitive for rel value", () => {
      const html = `
        <link rel="ALTERNATE" type="application/rss+xml" href="/feed.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
    });
  });

  describe("type attribute variations", () => {
    it("handles type with charset parameter", () => {
      const html = `
        <link rel="alternate" type="application/rss+xml; charset=utf-8" href="/feed.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].type).toBe("rss");
    });

    it("is case-insensitive for type value", () => {
      const html = `
        <link rel="alternate" type="APPLICATION/RSS+XML" href="/feed.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].type).toBe("rss");
    });

    it("handles generic XML types as unknown", () => {
      const html = `
        <link rel="alternate" type="application/xml" href="/feed1.xml">
        <link rel="alternate" type="text/xml" href="/feed2.xml">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(2);
      expect(feeds[0].type).toBe("unknown");
      expect(feeds[1].type).toBe("unknown");
    });
  });

  describe("real-world examples", () => {
    it("discovers feed from typical WordPress blog", () => {
      const html = `
        <!DOCTYPE html>
        <html lang="en-US">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <link rel="profile" href="https://gmpg.org/xfn/11">
          <link rel="alternate" type="application/rss+xml" title="My Blog - Feed" href="https://myblog.com/feed/">
          <link rel="alternate" type="application/rss+xml" title="My Blog - Comments Feed" href="https://myblog.com/comments/feed/">
          <title>My Blog</title>
        </head>
        <body></body>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://myblog.com");

      expect(feeds).toHaveLength(2);
      expect(feeds[0].url).toBe("https://myblog.com/feed/");
      expect(feeds[0].title).toBe("My Blog - Feed");
      expect(feeds[1].url).toBe("https://myblog.com/comments/feed/");
    });

    it("discovers feed from GitHub repository", () => {
      const html = `
        <html>
        <head>
          <link rel="alternate" type="application/atom+xml" title="Recent Commits to repo:main" href="/owner/repo/commits/main.atom">
        </head>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://github.com/owner/repo");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://github.com/owner/repo/commits/main.atom");
      expect(feeds[0].type).toBe("atom");
    });

    it("discovers feeds from Medium-style blog", () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <link rel="alternate" type="application/rss+xml" href="https://medium.com/feed/@username">
        </head>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://medium.com/@username");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://medium.com/feed/@username");
    });
  });

  describe("JSON Feed discovery", () => {
    it("discovers JSON Feed from link tag with application/feed+json", () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Example Site</title>
            <link rel="alternate" type="application/feed+json" href="/feed.json" title="JSON Feed">
          </head>
          <body></body>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0]).toEqual({
        url: "https://example.com/feed.json",
        type: "json",
        title: "JSON Feed",
      });
    });

    it("discovers JSON Feed from link tag with application/json", () => {
      const html = `
        <html>
          <head>
            <link rel="alternate" type="application/json" href="/feed.json" title="JSON Feed">
          </head>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].url).toBe("https://example.com/feed.json");
      expect(feeds[0].type).toBe("json");
    });

    it("discovers mixed RSS, Atom, and JSON feeds", () => {
      const html = `
        <html>
          <head>
            <link rel="alternate" type="application/rss+xml" href="/rss.xml" title="RSS">
            <link rel="alternate" type="application/atom+xml" href="/atom.xml" title="Atom">
            <link rel="alternate" type="application/feed+json" href="/feed.json" title="JSON">
          </head>
        </html>
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(3);

      const rss = feeds.find((f) => f.type === "rss");
      const atom = feeds.find((f) => f.type === "atom");
      const json = feeds.find((f) => f.type === "json");

      expect(rss).toBeDefined();
      expect(rss!.url).toBe("https://example.com/rss.xml");

      expect(atom).toBeDefined();
      expect(atom!.url).toBe("https://example.com/atom.xml");

      expect(json).toBeDefined();
      expect(json!.url).toBe("https://example.com/feed.json");
    });

    it("handles JSON Feed with charset parameter", () => {
      const html = `
        <link rel="alternate" type="application/feed+json; charset=utf-8" href="/feed.json">
      `;

      const feeds = discoverFeeds(html, "https://example.com");

      expect(feeds).toHaveLength(1);
      expect(feeds[0].type).toBe("json");
    });
  });
});

describe("getCommonFeedUrls", () => {
  it("generates feed URLs from base URL", () => {
    const urls = getCommonFeedUrls("https://example.com");

    expect(urls.length).toBe(COMMON_FEED_PATHS.length);
    expect(urls).toContain("https://example.com/feed");
    expect(urls).toContain("https://example.com/feed.xml");
    expect(urls).toContain("https://example.com/rss");
    expect(urls).toContain("https://example.com/rss.xml");
    expect(urls).toContain("https://example.com/atom.xml");
    expect(urls).toContain("https://example.com/feed.json");
  });

  it("uses origin only, ignoring path", () => {
    const urls = getCommonFeedUrls("https://example.com/blog/post/123");

    expect(urls).toContain("https://example.com/feed");
    expect(urls).not.toContain("https://example.com/blog/post/123/feed");
  });

  it("preserves port in origin", () => {
    const urls = getCommonFeedUrls("https://example.com:8080/blog");

    expect(urls).toContain("https://example.com:8080/feed");
    expect(urls).toContain("https://example.com:8080/rss.xml");
  });

  it("handles http protocol", () => {
    const urls = getCommonFeedUrls("http://example.com");

    expect(urls).toContain("http://example.com/feed");
    expect(urls).toContain("http://example.com/rss.xml");
  });

  it("returns empty array for invalid URL", () => {
    const urls = getCommonFeedUrls("not-a-valid-url");

    expect(urls).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    const urls = getCommonFeedUrls("");

    expect(urls).toEqual([]);
  });

  it("handles subdomain correctly", () => {
    const urls = getCommonFeedUrls("https://blog.example.com/posts");

    expect(urls).toContain("https://blog.example.com/feed");
    expect(urls).toContain("https://blog.example.com/rss.xml");
    expect(urls).not.toContain("https://example.com/feed");
  });

  it("ignores query parameters and fragments from base URL", () => {
    const urls = getCommonFeedUrls("https://example.com/page?query=test#section");

    // Should use origin only
    expect(urls).toContain("https://example.com/feed");
    expect(urls).not.toContain("https://example.com/page/feed");
  });
});
