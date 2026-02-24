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
  isLessWrongUserUrl,
  extractUserSlug,
  isLessWrongUserFeedUrl,
  extractUserIdFromFeedUrl,
  buildLessWrongUserFeedUrl,
  isLessWrongFrontpage,
  isLessWrongShortformPage,
  buildLessWrongPostCommentFeedUrl,
  buildLessWrongUserShortformFeedUrl,
  LESSWRONG_FRONTPAGE_FEED_URL,
  LESSWRONG_SHORTFORM_FRONTPAGE_FEED_URL,
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

  describe("isLessWrongUserUrl", () => {
    it("returns true for standard LessWrong user profile URLs", () => {
      expect(isLessWrongUserUrl("https://www.lesswrong.com/users/brendan-long")).toBe(true);
      expect(isLessWrongUserUrl("https://lesswrong.com/users/brendan-long")).toBe(true);
    });

    it("returns true for user URLs with trailing slash", () => {
      expect(isLessWrongUserUrl("https://www.lesswrong.com/users/eliezer_yudkowsky/")).toBe(true);
    });

    it("returns true for user URLs with query params", () => {
      expect(isLessWrongUserUrl("https://www.lesswrong.com/users/username?tab=posts")).toBe(true);
    });

    it("returns true for user URLs with hash fragments", () => {
      expect(isLessWrongUserUrl("https://www.lesswrong.com/users/username#section")).toBe(true);
    });

    it("returns true for HTTP URLs (not just HTTPS)", () => {
      expect(isLessWrongUserUrl("http://www.lesswrong.com/users/username")).toBe(true);
    });

    it("returns false for non-LessWrong URLs", () => {
      expect(isLessWrongUserUrl("https://example.com/users/username")).toBe(false);
      expect(isLessWrongUserUrl("https://greaterwrong.com/users/username")).toBe(false);
    });

    it("returns false for LessWrong non-user URLs", () => {
      expect(isLessWrongUserUrl("https://www.lesswrong.com")).toBe(false);
      expect(isLessWrongUserUrl("https://www.lesswrong.com/posts/abc/slug")).toBe(false);
      expect(isLessWrongUserUrl("https://www.lesswrong.com/tags/rationality")).toBe(false);
    });

    it("returns false for invalid URLs", () => {
      expect(isLessWrongUserUrl("not a url")).toBe(false);
      expect(isLessWrongUserUrl("")).toBe(false);
    });
  });

  describe("extractUserSlug", () => {
    it("extracts user slug from standard LessWrong user URLs", () => {
      expect(extractUserSlug("https://www.lesswrong.com/users/brendan-long")).toBe("brendan-long");
      expect(extractUserSlug("https://lesswrong.com/users/eliezer_yudkowsky")).toBe(
        "eliezer_yudkowsky"
      );
    });

    it("extracts user slug from URLs with trailing slash", () => {
      expect(extractUserSlug("https://www.lesswrong.com/users/username/")).toBe("username");
    });

    it("extracts user slug from URLs with query params", () => {
      expect(extractUserSlug("https://www.lesswrong.com/users/username?tab=posts")).toBe(
        "username"
      );
    });

    it("extracts user slug from URLs with hash fragments", () => {
      expect(extractUserSlug("https://www.lesswrong.com/users/username#section")).toBe("username");
    });

    it("returns null for non-LessWrong URLs", () => {
      expect(extractUserSlug("https://example.com/users/username")).toBe(null);
    });

    it("returns null for LessWrong non-user URLs", () => {
      expect(extractUserSlug("https://www.lesswrong.com")).toBe(null);
      expect(extractUserSlug("https://www.lesswrong.com/posts/abc/slug")).toBe(null);
    });

    it("returns null for invalid URLs", () => {
      expect(extractUserSlug("not a url")).toBe(null);
      expect(extractUserSlug("")).toBe(null);
    });
  });

  describe("isLessWrongUserFeedUrl", () => {
    it("returns true for LessWrong user feed URLs", () => {
      expect(
        isLessWrongUserFeedUrl("https://www.lesswrong.com/feed.xml?userId=piR3ZKGHEp6vqTo87")
      ).toBe(true);
      expect(
        isLessWrongUserFeedUrl("https://lesswrong.com/feed.xml?userId=piR3ZKGHEp6vqTo87")
      ).toBe(true);
    });

    it("returns true for feed URLs with additional query params", () => {
      expect(
        isLessWrongUserFeedUrl(
          "https://www.lesswrong.com/feed.xml?userId=piR3ZKGHEp6vqTo87&format=rss"
        )
      ).toBe(true);
    });

    it("returns false for LessWrong feed URLs without userId", () => {
      expect(isLessWrongUserFeedUrl("https://www.lesswrong.com/feed.xml")).toBe(false);
    });

    it("returns false for non-LessWrong URLs", () => {
      expect(isLessWrongUserFeedUrl("https://example.com/feed.xml?userId=abc")).toBe(false);
    });

    it("returns false for invalid URLs", () => {
      expect(isLessWrongUserFeedUrl("not a url")).toBe(false);
      expect(isLessWrongUserFeedUrl("")).toBe(false);
    });
  });

  describe("extractUserIdFromFeedUrl", () => {
    it("extracts userId from LessWrong user feed URLs", () => {
      expect(
        extractUserIdFromFeedUrl("https://www.lesswrong.com/feed.xml?userId=piR3ZKGHEp6vqTo87")
      ).toBe("piR3ZKGHEp6vqTo87");
    });

    it("extracts userId when there are additional query params", () => {
      expect(
        extractUserIdFromFeedUrl(
          "https://www.lesswrong.com/feed.xml?format=rss&userId=abc123&other=value"
        )
      ).toBe("abc123");
    });

    it("returns null for feed URLs without userId", () => {
      expect(extractUserIdFromFeedUrl("https://www.lesswrong.com/feed.xml")).toBe(null);
    });

    it("returns null for non-LessWrong URLs", () => {
      expect(extractUserIdFromFeedUrl("https://example.com/feed.xml?userId=abc")).toBe(null);
    });

    it("returns null for non-feed LessWrong URLs", () => {
      expect(extractUserIdFromFeedUrl("https://www.lesswrong.com/users/username?userId=abc")).toBe(
        null
      );
    });

    it("returns null for invalid URLs", () => {
      expect(extractUserIdFromFeedUrl("not a url")).toBe(null);
      expect(extractUserIdFromFeedUrl("")).toBe(null);
    });
  });

  describe("buildLessWrongUserFeedUrl", () => {
    it("builds a user feed URL from a user ID", () => {
      expect(buildLessWrongUserFeedUrl("piR3ZKGHEp6vqTo87")).toBe(
        "https://www.lesswrong.com/feed.xml?userId=piR3ZKGHEp6vqTo87"
      );
    });

    it("properly encodes special characters in user ID", () => {
      expect(buildLessWrongUserFeedUrl("user+id&special=chars")).toBe(
        "https://www.lesswrong.com/feed.xml?userId=user%2Bid%26special%3Dchars"
      );
    });
  });

  describe("isLessWrongFrontpage", () => {
    it("returns true for the LessWrong front page", () => {
      expect(isLessWrongFrontpage("https://www.lesswrong.com")).toBe(true);
      expect(isLessWrongFrontpage("https://www.lesswrong.com/")).toBe(true);
      expect(isLessWrongFrontpage("https://lesswrong.com")).toBe(true);
      expect(isLessWrongFrontpage("https://lesswrong.com/")).toBe(true);
    });

    it("returns true for the front page with query params", () => {
      expect(isLessWrongFrontpage("https://www.lesswrong.com/?ref=foo")).toBe(true);
    });

    it("returns true for the front page with hash fragment", () => {
      expect(isLessWrongFrontpage("https://www.lesswrong.com/#section")).toBe(true);
    });

    it("returns true for HTTP URLs", () => {
      expect(isLessWrongFrontpage("http://www.lesswrong.com")).toBe(true);
    });

    it("returns false for non-LessWrong URLs", () => {
      expect(isLessWrongFrontpage("https://example.com")).toBe(false);
      expect(isLessWrongFrontpage("https://greaterwrong.com")).toBe(false);
    });

    it("returns false for LessWrong sub-pages", () => {
      expect(isLessWrongFrontpage("https://www.lesswrong.com/posts/abc/slug")).toBe(false);
      expect(isLessWrongFrontpage("https://www.lesswrong.com/users/username")).toBe(false);
      expect(isLessWrongFrontpage("https://www.lesswrong.com/quicktakes")).toBe(false);
    });

    it("returns false for invalid URLs", () => {
      expect(isLessWrongFrontpage("not a url")).toBe(false);
      expect(isLessWrongFrontpage("")).toBe(false);
    });
  });

  describe("isLessWrongShortformPage", () => {
    it("returns true for the LessWrong quicktakes page", () => {
      expect(isLessWrongShortformPage("https://www.lesswrong.com/quicktakes")).toBe(true);
      expect(isLessWrongShortformPage("https://lesswrong.com/quicktakes")).toBe(true);
    });

    it("returns true for quicktakes with trailing slash", () => {
      expect(isLessWrongShortformPage("https://www.lesswrong.com/quicktakes/")).toBe(true);
    });

    it("returns true for quicktakes with query params", () => {
      expect(isLessWrongShortformPage("https://www.lesswrong.com/quicktakes?sort=new")).toBe(true);
    });

    it("returns true for quicktakes with hash fragment", () => {
      expect(isLessWrongShortformPage("https://www.lesswrong.com/quicktakes#top")).toBe(true);
    });

    it("returns true for HTTP URLs", () => {
      expect(isLessWrongShortformPage("http://www.lesswrong.com/quicktakes")).toBe(true);
    });

    it("returns false for non-LessWrong URLs", () => {
      expect(isLessWrongShortformPage("https://example.com/quicktakes")).toBe(false);
    });

    it("returns false for LessWrong non-quicktakes URLs", () => {
      expect(isLessWrongShortformPage("https://www.lesswrong.com")).toBe(false);
      expect(isLessWrongShortformPage("https://www.lesswrong.com/posts/abc/slug")).toBe(false);
      expect(isLessWrongShortformPage("https://www.lesswrong.com/users/username")).toBe(false);
    });

    it("returns false for invalid URLs", () => {
      expect(isLessWrongShortformPage("not a url")).toBe(false);
      expect(isLessWrongShortformPage("")).toBe(false);
    });
  });

  describe("buildLessWrongPostCommentFeedUrl", () => {
    it("builds a post comment feed URL from a post ID", () => {
      expect(buildLessWrongPostCommentFeedUrl("NjzLuhdneE3mXY8we")).toBe(
        "https://www.lesswrong.com/feed.xml?type=comments&view=postCommentsNew&postId=NjzLuhdneE3mXY8we"
      );
    });

    it("properly encodes special characters in post ID", () => {
      expect(buildLessWrongPostCommentFeedUrl("id+with&special=chars")).toBe(
        "https://www.lesswrong.com/feed.xml?type=comments&view=postCommentsNew&postId=id%2Bwith%26special%3Dchars"
      );
    });
  });

  describe("buildLessWrongUserShortformFeedUrl", () => {
    it("builds a user shortform feed URL from a user ID", () => {
      expect(buildLessWrongUserShortformFeedUrl("6jLdWqegNefgaabhr")).toBe(
        "https://www.lesswrong.com/feed.xml?type=comments&view=shortform&userId=6jLdWqegNefgaabhr"
      );
    });

    it("properly encodes special characters in user ID", () => {
      expect(buildLessWrongUserShortformFeedUrl("user+id&special=chars")).toBe(
        "https://www.lesswrong.com/feed.xml?type=comments&view=shortform&userId=user%2Bid%26special%3Dchars"
      );
    });
  });

  describe("feed URL constants", () => {
    it("has the correct frontpage feed URL", () => {
      expect(LESSWRONG_FRONTPAGE_FEED_URL).toBe(
        "https://www.lesswrong.com/feed.xml?view=frontpage"
      );
    });

    it("has the correct shortform frontpage feed URL", () => {
      expect(LESSWRONG_SHORTFORM_FRONTPAGE_FEED_URL).toBe(
        "https://www.lesswrong.com/feed.xml?type=comments&view=shortformFrontpage"
      );
    });
  });
});
