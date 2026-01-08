/**
 * Unit tests for LessWrong feed URL detection.
 *
 * These test the pure functions that determine if a URL is the LessWrong
 * main feed that should use the GraphQL API fetcher.
 */

import { describe, it, expect } from "vitest";
import { isLessWrongFeedUrl } from "../../src/server/feed/lesswrong-feed";

describe("LessWrong feed URL detection", () => {
  describe("isLessWrongFeedUrl", () => {
    it("returns true for LessWrong feed.xml URL", () => {
      expect(isLessWrongFeedUrl("https://www.lesswrong.com/feed.xml")).toBe(true);
      expect(isLessWrongFeedUrl("https://lesswrong.com/feed.xml")).toBe(true);
      expect(isLessWrongFeedUrl("http://www.lesswrong.com/feed.xml")).toBe(true);
      expect(isLessWrongFeedUrl("http://lesswrong.com/feed.xml")).toBe(true);
    });

    it("returns true for LessWrong /feed URL", () => {
      expect(isLessWrongFeedUrl("https://www.lesswrong.com/feed")).toBe(true);
      expect(isLessWrongFeedUrl("https://lesswrong.com/feed")).toBe(true);
    });

    it("returns true for LessWrong rss.xml URL", () => {
      expect(isLessWrongFeedUrl("https://www.lesswrong.com/rss.xml")).toBe(true);
      expect(isLessWrongFeedUrl("https://lesswrong.com/rss.xml")).toBe(true);
    });

    it("returns false for LessWrong non-feed URLs", () => {
      expect(isLessWrongFeedUrl("https://www.lesswrong.com")).toBe(false);
      expect(
        isLessWrongFeedUrl("https://www.lesswrong.com/posts/WQFioaudEH8R7fyhm/some-post")
      ).toBe(false);
      expect(isLessWrongFeedUrl("https://www.lesswrong.com/users/someuser")).toBe(false);
      expect(isLessWrongFeedUrl("https://www.lesswrong.com/tags/rationality")).toBe(false);
    });

    it("returns false for LessWrong feed URLs with extra path segments", () => {
      // These shouldn't match - they might be user-specific feeds or other variants
      expect(isLessWrongFeedUrl("https://www.lesswrong.com/feed.xml/extra")).toBe(false);
      expect(isLessWrongFeedUrl("https://www.lesswrong.com/users/someuser/feed.xml")).toBe(false);
    });

    it("returns false for non-LessWrong feed URLs", () => {
      expect(isLessWrongFeedUrl("https://example.com/feed.xml")).toBe(false);
      expect(isLessWrongFeedUrl("https://greaterwrong.com/feed.xml")).toBe(false);
      expect(isLessWrongFeedUrl("https://forum.effectivealtruism.org/feed.xml")).toBe(false);
    });

    it("returns false for invalid URLs", () => {
      expect(isLessWrongFeedUrl("not a url")).toBe(false);
      expect(isLessWrongFeedUrl("")).toBe(false);
      expect(isLessWrongFeedUrl("lesswrong.com/feed.xml")).toBe(false);
    });
  });
});
