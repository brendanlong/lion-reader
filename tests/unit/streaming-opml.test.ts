/**
 * Unit tests for OPML parser.
 */

import { describe, it, expect } from "vitest";
import { parseOpml, OpmlParseError } from "../../src/server/feed/streaming/opml-parser";

describe("parseOpml", () => {
  describe("standard OPML", () => {
    it("parses a basic OPML file with feeds", () => {
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

      const result = parseOpml(xml);

      expect(result.feeds).toHaveLength(2);
      expect(result.feeds[0]).toEqual({
        title: "Example Blog",
        xmlUrl: "https://example.com/feed.xml",
        htmlUrl: "https://example.com",
      });
      expect(result.feeds[1]).toEqual({
        title: "Another Blog",
        xmlUrl: "https://another.com/rss",
        htmlUrl: undefined,
      });
    });
  });

  describe("nested folders", () => {
    it("parses nested folder structure with categories", () => {
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

      const result = parseOpml(xml);

      expect(result.feeds).toHaveLength(3);

      expect(result.feeds[0]).toEqual({
        title: "Coding Blog",
        xmlUrl: "https://coding.com/feed",
        htmlUrl: undefined,
        category: ["Tech", "Programming"],
      });

      expect(result.feeds[1]).toEqual({
        title: "Tech News",
        xmlUrl: "https://technews.com/rss",
        htmlUrl: undefined,
        category: ["Tech"],
      });

      expect(result.feeds[2]).toEqual({
        title: "Uncategorized",
        xmlUrl: "https://uncategorized.com/feed",
        htmlUrl: undefined,
      });
    });
  });

  describe("category attribute", () => {
    it("uses category attribute when present", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
          <body>
            <outline type="rss" text="Feed" xmlUrl="https://example.com/feed" category="News"/>
          </body>
        </opml>`;

      const result = parseOpml(xml);

      expect(result.feeds[0].category).toEqual(["News"]);
    });

    it("handles slash-separated category paths", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
          <body>
            <outline type="rss" text="Feed" xmlUrl="https://example.com/feed"
                     category="Tech/Programming/JavaScript"/>
          </body>
        </opml>`;

      const result = parseOpml(xml);

      expect(result.feeds[0].category).toEqual(["Tech", "Programming", "JavaScript"]);
    });
  });

  describe("attribute case handling", () => {
    it("handles different attribute cases for xmlUrl", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
          <body>
            <outline type="rss" text="Feed1" xmlUrl="https://example1.com/feed"/>
            <outline type="rss" text="Feed2" xmlurl="https://example2.com/feed"/>
          </body>
        </opml>`;

      const result = parseOpml(xml);

      expect(result.feeds).toHaveLength(2);
      expect(result.feeds[0].xmlUrl).toBe("https://example1.com/feed");
      expect(result.feeds[1].xmlUrl).toBe("https://example2.com/feed");
    });
  });

  describe("empty OPML", () => {
    it("returns empty feeds array for empty body", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Empty</title></head>
          <body></body>
        </opml>`;

      const result = parseOpml(xml);

      expect(result.feeds).toEqual([]);
    });
  });

  describe("validation", () => {
    it("throws for missing opml element", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <something>
          <body></body>
        </something>`;

      expect(() => parseOpml(xml)).toThrow(OpmlParseError);
      expect(() => parseOpml(xml)).toThrow("missing opml element");
    });

    it("throws for missing body element", () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
        <opml version="2.0">
          <head><title>Test</title></head>
        </opml>`;

      expect(() => parseOpml(xml)).toThrow(OpmlParseError);
      expect(() => parseOpml(xml)).toThrow("missing body element");
    });
  });
});
