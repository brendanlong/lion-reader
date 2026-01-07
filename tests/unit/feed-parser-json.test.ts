/**
 * Unit tests for JSON Feed 1.1 parser.
 */

import { describe, it, expect } from "vitest";
import { parseJsonFeed, parseJsonFeedDate, isJsonFeed } from "../../src/server/feed/json-parser";

describe("isJsonFeed", () => {
  it("returns true for valid JSON Feed 1.1", () => {
    const json = JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "Test Feed",
      items: [],
    });

    expect(isJsonFeed(json)).toBe(true);
  });

  it("returns true for JSON Feed 1.0", () => {
    const json = JSON.stringify({
      version: "https://jsonfeed.org/version/1",
      title: "Test Feed",
      items: [],
    });

    expect(isJsonFeed(json)).toBe(true);
  });

  it("returns false for non-JSON string", () => {
    expect(isJsonFeed("This is not JSON")).toBe(false);
  });

  it("returns false for JSON without version", () => {
    const json = JSON.stringify({
      title: "Test Feed",
      items: [],
    });

    expect(isJsonFeed(json)).toBe(false);
  });

  it("returns false for JSON with wrong version format", () => {
    const json = JSON.stringify({
      version: "1.1",
      title: "Test Feed",
      items: [],
    });

    expect(isJsonFeed(json)).toBe(false);
  });

  it("returns false for non-object JSON (array)", () => {
    expect(isJsonFeed("[]")).toBe(false);
  });

  it("returns false for non-object JSON (null)", () => {
    expect(isJsonFeed("null")).toBe(false);
  });

  it("returns false for non-object JSON (string)", () => {
    expect(isJsonFeed('"hello"')).toBe(false);
  });
});

describe("parseJsonFeed", () => {
  describe("standard JSON Feed 1.1", () => {
    it("parses a standard JSON Feed 1.1 with all elements", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Example Feed",
        home_page_url: "https://example.com",
        feed_url: "https://example.com/feed.json",
        description: "An example JSON feed",
        favicon: "https://example.com/favicon.ico",
        authors: [{ name: "John Doe", url: "https://example.com/johndoe" }],
        items: [
          {
            id: "post-1",
            url: "https://example.com/post-1",
            title: "First Post",
            content_html: "<p>This is the full content.</p>",
            summary: "This is the first post summary",
            date_published: "2024-01-01T12:00:00Z",
            date_modified: "2024-01-02T12:00:00Z",
            authors: [{ name: "Jane Doe" }],
          },
          {
            id: "post-2",
            url: "https://example.com/post-2",
            title: "Second Post",
            content_text: "This is plain text content",
            date_published: "2024-01-02T12:00:00Z",
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.title).toBe("Example Feed");
      expect(feed.description).toBe("An example JSON feed");
      expect(feed.siteUrl).toBe("https://example.com");
      expect(feed.iconUrl).toBe("https://example.com/favicon.ico");
      expect(feed.selfUrl).toBe("https://example.com/feed.json");
      expect(feed.items).toHaveLength(2);

      expect(feed.items[0].guid).toBe("post-1");
      expect(feed.items[0].link).toBe("https://example.com/post-1");
      expect(feed.items[0].title).toBe("First Post");
      expect(feed.items[0].content).toBe("<p>This is the full content.</p>");
      expect(feed.items[0].summary).toBe("This is the first post summary");
      expect(feed.items[0].author).toBe("Jane Doe");
      expect(feed.items[0].pubDate).toEqual(new Date("2024-01-01T12:00:00Z"));

      expect(feed.items[1].guid).toBe("post-2");
      expect(feed.items[1].content).toBe("This is plain text content");
      expect(feed.items[1].pubDate).toEqual(new Date("2024-01-02T12:00:00Z"));
    });

    it("handles a single item", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Single Item Feed",
        items: [
          {
            id: "only-post",
            title: "Only Post",
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].title).toBe("Only Post");
    });
  });

  describe("feed with missing optional fields", () => {
    it("parses feed with minimal required elements", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Minimal Feed",
        items: [],
      });

      const feed = parseJsonFeed(json);

      expect(feed.title).toBe("Minimal Feed");
      expect(feed.description).toBeUndefined();
      expect(feed.siteUrl).toBeUndefined();
      expect(feed.iconUrl).toBeUndefined();
      expect(feed.items).toHaveLength(0);
    });

    it("handles items with missing optional fields", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed with sparse items",
        items: [
          {
            id: "minimal-entry",
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].guid).toBe("minimal-entry");
      expect(feed.items[0].title).toBeUndefined();
      expect(feed.items[0].link).toBeUndefined();
      expect(feed.items[0].author).toBeUndefined();
      expect(feed.items[0].content).toBeUndefined();
      expect(feed.items[0].summary).toBeUndefined();
      expect(feed.items[0].pubDate).toBeUndefined();
    });

    it("returns undefined title for feed without title", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        items: [],
      });

      const feed = parseJsonFeed(json);
      expect(feed.title).toBeUndefined();
    });

    it("returns undefined title for feed with empty title", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "   ",
        items: [],
      });

      const feed = parseJsonFeed(json);
      expect(feed.title).toBeUndefined();
    });

    it("throws error for missing version", () => {
      const json = JSON.stringify({
        title: "No version",
        items: [],
      });

      expect(() => parseJsonFeed(json)).toThrow("Invalid JSON Feed: missing or invalid version");
    });

    it("throws error for invalid version format", () => {
      const json = JSON.stringify({
        version: "1.1",
        title: "Wrong version",
        items: [],
      });

      expect(() => parseJsonFeed(json)).toThrow("Invalid JSON Feed: missing or invalid version");
    });

    it("throws error for missing items array", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "No items",
      });

      expect(() => parseJsonFeed(json)).toThrow("Invalid JSON Feed: missing items array");
    });

    it("throws error for invalid JSON", () => {
      expect(() => parseJsonFeed("not json")).toThrow("Invalid JSON Feed: failed to parse JSON");
    });

    it("throws error for non-object JSON", () => {
      expect(() => parseJsonFeed("[]")).toThrow("Invalid JSON Feed: root must be an object");
      expect(() => parseJsonFeed("null")).toThrow("Invalid JSON Feed: root must be an object");
    });
  });

  describe("content handling", () => {
    it("prefers content_html over content_text for content", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Content Priority Feed",
        items: [
          {
            id: "post-both",
            content_html: "<p>Full HTML content</p>",
            content_text: "Plain text content",
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.items[0].content).toBe("<p>Full HTML content</p>");
    });

    it("falls back to content_text when content_html is not present", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Text Only Feed",
        items: [
          {
            id: "post-text",
            content_text: "This is plain text content",
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.items[0].content).toBe("This is plain text content");
    });

    it("uses summary if available, otherwise content_text", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Summary Feed",
        items: [
          {
            id: "post-with-summary",
            content_html: "<p>Full content</p>",
            summary: "Short summary",
          },
          {
            id: "post-without-summary",
            content_html: "<p>Full content</p>",
            content_text: "Text version",
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.items[0].summary).toBe("Short summary");
      expect(feed.items[1].summary).toBe("Text version");
    });
  });

  describe("author handling", () => {
    it("extracts author name from authors array (1.1)", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Authors Feed",
        items: [
          {
            id: "post-author",
            authors: [{ name: "Jane Doe", url: "https://example.com/jane" }],
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.items[0].author).toBe("Jane Doe");
    });

    it("uses first author from multiple authors", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Multi-Author Feed",
        items: [
          {
            id: "post-multi-author",
            authors: [{ name: "First Author" }, { name: "Second Author" }],
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.items[0].author).toBe("First Author");
    });

    it("falls back to deprecated author object (1.0)", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1",
        title: "Legacy Author Feed",
        items: [
          {
            id: "post-legacy",
            author: { name: "Legacy Author" },
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.items[0].author).toBe("Legacy Author");
    });

    it("prefers authors array over deprecated author object", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Mixed Author Feed",
        items: [
          {
            id: "post-mixed",
            authors: [{ name: "New Author" }],
            author: { name: "Old Author" },
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.items[0].author).toBe("New Author");
    });
  });

  describe("date handling", () => {
    it("prefers date_published over date_modified", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Date Priority Feed",
        items: [
          {
            id: "post-dates",
            date_published: "2024-01-01T10:00:00Z",
            date_modified: "2024-01-02T12:00:00Z",
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.items[0].pubDate).toEqual(new Date("2024-01-01T10:00:00Z"));
    });

    it("falls back to date_modified when date_published is missing", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Modified Only Feed",
        items: [
          {
            id: "post-modified",
            date_modified: "2024-01-02T12:00:00Z",
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.items[0].pubDate).toEqual(new Date("2024-01-02T12:00:00Z"));
    });
  });

  describe("icon handling", () => {
    it("prefers favicon over icon", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Icons Feed",
        favicon: "https://example.com/favicon.ico",
        icon: "https://example.com/icon.png",
        items: [],
      });

      const feed = parseJsonFeed(json);

      expect(feed.iconUrl).toBe("https://example.com/favicon.ico");
    });

    it("falls back to icon when favicon is missing", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Icon Only Feed",
        icon: "https://example.com/icon.png",
        items: [],
      });

      const feed = parseJsonFeed(json);

      expect(feed.iconUrl).toBe("https://example.com/icon.png");
    });
  });

  describe("URL handling", () => {
    it("uses url as primary link", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "URL Feed",
        items: [
          {
            id: "post-url",
            url: "https://example.com/post",
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.items[0].link).toBe("https://example.com/post");
    });

    it("falls back to external_url when url is missing", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "External URL Feed",
        items: [
          {
            id: "post-external",
            external_url: "https://external.com/article",
          },
        ],
      });

      const feed = parseJsonFeed(json);

      expect(feed.items[0].link).toBe("https://external.com/article");
    });
  });

  describe("WebSub hubs handling", () => {
    it("extracts WebSub hub URL from hubs array", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "WebSub Feed",
        hubs: [{ type: "websub", url: "https://pubsubhubbub.appspot.com" }],
        items: [],
      });

      const feed = parseJsonFeed(json);

      expect(feed.hubUrl).toBe("https://pubsubhubbub.appspot.com");
    });

    it("prefers websub type over other hub types", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Multi-Hub Feed",
        hubs: [
          { type: "other", url: "https://other-hub.com" },
          { type: "websub", url: "https://websub-hub.com" },
        ],
        items: [],
      });

      const feed = parseJsonFeed(json);

      expect(feed.hubUrl).toBe("https://websub-hub.com");
    });

    it("falls back to first hub if no websub type found", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Non-WebSub Hub Feed",
        hubs: [{ type: "rsscloud", url: "https://rsscloud.com" }],
        items: [],
      });

      const feed = parseJsonFeed(json);

      expect(feed.hubUrl).toBe("https://rsscloud.com");
    });

    it("handles missing hubs", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "No Hubs Feed",
        items: [],
      });

      const feed = parseJsonFeed(json);

      expect(feed.hubUrl).toBeUndefined();
    });
  });

  describe("whitespace handling", () => {
    it("trims title", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "  Trimmed Title  ",
        items: [],
      });

      const feed = parseJsonFeed(json);

      expect(feed.title).toBe("Trimmed Title");
    });

    it("trims description", () => {
      const json = JSON.stringify({
        version: "https://jsonfeed.org/version/1.1",
        title: "Feed",
        description: "  Trimmed description  ",
        items: [],
      });

      const feed = parseJsonFeed(json);

      expect(feed.description).toBe("Trimmed description");
    });
  });
});

describe("parseJsonFeedDate", () => {
  describe("ISO 8601 format", () => {
    it("parses standard ISO 8601 dates with Z timezone", () => {
      expect(parseJsonFeedDate("2024-01-01T12:00:00Z")).toEqual(new Date("2024-01-01T12:00:00Z"));
    });

    it("parses ISO 8601 with positive timezone offset", () => {
      const date = parseJsonFeedDate("2024-01-01T12:00:00+05:00");
      expect(date).toEqual(new Date("2024-01-01T07:00:00Z"));
    });

    it("parses ISO 8601 with negative timezone offset", () => {
      const date = parseJsonFeedDate("2024-01-01T12:00:00-05:00");
      expect(date).toEqual(new Date("2024-01-01T17:00:00Z"));
    });

    it("parses date without time", () => {
      const date = parseJsonFeedDate("2024-01-01");
      expect(date).toBeDefined();
      expect(date?.getUTCFullYear()).toBe(2024);
      expect(date?.getUTCMonth()).toBe(0); // January
      expect(date?.getUTCDate()).toBe(1);
    });

    it("parses ISO 8601 with milliseconds", () => {
      expect(parseJsonFeedDate("2024-01-01T12:00:00.123Z")).toEqual(
        new Date("2024-01-01T12:00:00.123Z")
      );
    });
  });

  describe("edge cases", () => {
    it("returns undefined for empty string", () => {
      expect(parseJsonFeedDate("")).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(parseJsonFeedDate(undefined)).toBeUndefined();
    });

    it("returns undefined for invalid date string", () => {
      expect(parseJsonFeedDate("not a date")).toBeUndefined();
    });

    it("trims whitespace from date strings", () => {
      expect(parseJsonFeedDate("  2024-01-01T12:00:00Z  ")).toEqual(
        new Date("2024-01-01T12:00:00Z")
      );
    });
  });
});
