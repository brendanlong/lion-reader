/**
 * Unit tests for LessWrong URL detection and post ID extraction.
 *
 * These test the pure functions that determine if a URL is from LessWrong
 * and extract the post ID for GraphQL API calls.
 */

import { describe, it, expect } from "vitest";
import {
  isLessWrongUrl,
  extractPostId,
  extractCommentId,
  isLessWrongCommentUrl,
} from "../../src/server/feed/lesswrong";

describe("LessWrong URL detection", () => {
  describe("isLessWrongUrl", () => {
    it("returns true for standard LessWrong post URLs", () => {
      expect(
        isLessWrongUrl(
          "https://www.lesswrong.com/posts/WQFioaudEH8R7fyhm/local-validity-as-a-key-to-sanity-and-civilization"
        )
      ).toBe(true);
      expect(
        isLessWrongUrl(
          "https://lesswrong.com/posts/WQFioaudEH8R7fyhm/local-validity-as-a-key-to-sanity-and-civilization"
        )
      ).toBe(true);
    });

    it("returns true for LessWrong post URLs without slug", () => {
      expect(isLessWrongUrl("https://www.lesswrong.com/posts/WQFioaudEH8R7fyhm")).toBe(true);
      expect(isLessWrongUrl("https://lesswrong.com/posts/WQFioaudEH8R7fyhm")).toBe(true);
    });

    it("returns true for LessWrong post URLs with query params", () => {
      expect(
        isLessWrongUrl(
          "https://www.lesswrong.com/posts/WQFioaudEH8R7fyhm/some-slug?commentId=abc123"
        )
      ).toBe(true);
      expect(isLessWrongUrl("https://lesswrong.com/posts/WQFioaudEH8R7fyhm?ref=foo")).toBe(true);
    });

    it("returns true for LessWrong post URLs with hash fragments", () => {
      expect(
        isLessWrongUrl("https://www.lesswrong.com/posts/WQFioaudEH8R7fyhm/slug#comments")
      ).toBe(true);
    });

    it("returns true for HTTP URLs (not just HTTPS)", () => {
      expect(isLessWrongUrl("http://www.lesswrong.com/posts/WQFioaudEH8R7fyhm/slug")).toBe(true);
      expect(isLessWrongUrl("http://lesswrong.com/posts/WQFioaudEH8R7fyhm/slug")).toBe(true);
    });

    it("returns false for non-LessWrong URLs", () => {
      expect(isLessWrongUrl("https://example.com/article")).toBe(false);
      expect(isLessWrongUrl("https://google.com")).toBe(false);
      expect(isLessWrongUrl("https://greaterwrong.com/posts/WQFioaudEH8R7fyhm/slug")).toBe(false);
    });

    it("returns false for LessWrong non-post URLs", () => {
      expect(isLessWrongUrl("https://www.lesswrong.com")).toBe(false);
      expect(isLessWrongUrl("https://www.lesswrong.com/users/eliezer_yudkowsky")).toBe(false);
      expect(isLessWrongUrl("https://www.lesswrong.com/tags/rationality")).toBe(false);
      expect(isLessWrongUrl("https://www.lesswrong.com/sequences/abc")).toBe(false);
    });

    it("returns false for invalid URLs", () => {
      expect(isLessWrongUrl("not a url")).toBe(false);
      expect(isLessWrongUrl("")).toBe(false);
      expect(isLessWrongUrl("lesswrong.com/posts/WQFioaudEH8R7fyhm")).toBe(false);
    });
  });

  describe("extractPostId", () => {
    it("extracts post ID from standard LessWrong URLs", () => {
      expect(
        extractPostId(
          "https://www.lesswrong.com/posts/WQFioaudEH8R7fyhm/local-validity-as-a-key-to-sanity-and-civilization"
        )
      ).toBe("WQFioaudEH8R7fyhm");
      expect(extractPostId("https://lesswrong.com/posts/LJiGhpq8w4Badr5KJ/graphql-tutorial")).toBe(
        "LJiGhpq8w4Badr5KJ"
      );
    });

    it("extracts post ID from URLs without slug", () => {
      expect(extractPostId("https://www.lesswrong.com/posts/WQFioaudEH8R7fyhm")).toBe(
        "WQFioaudEH8R7fyhm"
      );
    });

    it("extracts post ID from URLs with query params", () => {
      expect(
        extractPostId("https://www.lesswrong.com/posts/WQFioaudEH8R7fyhm/slug?commentId=abc")
      ).toBe("WQFioaudEH8R7fyhm");
    });

    it("extracts post ID from URLs with hash fragments", () => {
      expect(extractPostId("https://www.lesswrong.com/posts/WQFioaudEH8R7fyhm/slug#section")).toBe(
        "WQFioaudEH8R7fyhm"
      );
    });

    it("returns null for non-LessWrong URLs", () => {
      expect(extractPostId("https://example.com/article")).toBe(null);
      expect(extractPostId("https://greaterwrong.com/posts/WQFioaudEH8R7fyhm/slug")).toBe(null);
    });

    it("returns null for LessWrong non-post URLs", () => {
      expect(extractPostId("https://www.lesswrong.com")).toBe(null);
      expect(extractPostId("https://www.lesswrong.com/users/eliezer")).toBe(null);
    });

    it("returns null for posts with invalid ID length", () => {
      // Post IDs should be exactly 17 characters
      expect(extractPostId("https://www.lesswrong.com/posts/short/slug")).toBe(null);
      expect(extractPostId("https://www.lesswrong.com/posts/waytoolongtobeavalidpostid/slug")).toBe(
        null
      );
    });

    it("returns null for invalid URLs", () => {
      expect(extractPostId("not a url")).toBe(null);
      expect(extractPostId("")).toBe(null);
    });
  });

  describe("extractCommentId", () => {
    it("extracts comment ID from URLs with commentId query param", () => {
      expect(
        extractCommentId(
          "https://www.lesswrong.com/posts/ZnNeKw2Be8BR7bmeN/adamzerner-s-shortform?commentId=F2mFKsTHbt24KeLNT"
        )
      ).toBe("F2mFKsTHbt24KeLNT");
    });

    it("extracts comment ID when there are other query params", () => {
      expect(
        extractCommentId(
          "https://www.lesswrong.com/posts/WQFioaudEH8R7fyhm/slug?ref=foo&commentId=abc123&other=bar"
        )
      ).toBe("abc123");
    });

    it("returns null for URLs without commentId", () => {
      expect(extractCommentId("https://www.lesswrong.com/posts/WQFioaudEH8R7fyhm/slug")).toBe(null);
      expect(
        extractCommentId("https://www.lesswrong.com/posts/WQFioaudEH8R7fyhm/slug?ref=foo")
      ).toBe(null);
    });

    it("returns null for invalid URLs", () => {
      expect(extractCommentId("not a url")).toBe(null);
      expect(extractCommentId("")).toBe(null);
    });
  });

  describe("isLessWrongCommentUrl", () => {
    it("returns true for LessWrong post URLs with commentId", () => {
      expect(
        isLessWrongCommentUrl(
          "https://www.lesswrong.com/posts/ZnNeKw2Be8BR7bmeN/adamzerner-s-shortform?commentId=F2mFKsTHbt24KeLNT"
        )
      ).toBe(true);
    });

    it("returns false for LessWrong post URLs without commentId", () => {
      expect(isLessWrongCommentUrl("https://www.lesswrong.com/posts/WQFioaudEH8R7fyhm/slug")).toBe(
        false
      );
    });

    it("returns false for non-LessWrong URLs even with commentId", () => {
      expect(isLessWrongCommentUrl("https://example.com/posts/abc?commentId=123")).toBe(false);
    });
  });
});
