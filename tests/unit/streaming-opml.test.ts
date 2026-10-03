/**
 * Unit tests for the synchronous OPML parser. General parsing (folders,
 * categories, validation) is covered through parseOpmlAsync in opml.test.ts.
 */

import { describe, it, expect } from "vitest";
import { parseOpml } from "../../src/server/feed/streaming/opml-parser";

describe("parseOpml", () => {
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
});
