/**
 * Unit tests for LessWrong API-based feed helpers.
 *
 * Tests URL building/parsing, title generation, and post-to-entry conversion.
 */

import { describe, it, expect } from "vitest";
import {
  buildLessWrongFeedUrl,
  parseLessWrongFeedUrl,
  isLessWrongFeedUrl,
  getLessWrongFeedTitle,
  lessWrongPostToParsedEntry,
  lessWrongPostsToParsedFeed,
  type LessWrongFeedConfig,
  type LessWrongPost,
} from "@/server/feed/lesswrong-feed";

// ============================================================================
// URL Building / Parsing
// ============================================================================

describe("buildLessWrongFeedUrl", () => {
  it("builds frontpage URL", () => {
    expect(buildLessWrongFeedUrl({ view: "frontpage" })).toBe("lesswrong://frontpage");
  });

  it("builds curated URL", () => {
    expect(buildLessWrongFeedUrl({ view: "curated" })).toBe("lesswrong://curated");
  });

  it("builds all posts URL", () => {
    expect(buildLessWrongFeedUrl({ view: "all" })).toBe("lesswrong://all");
  });

  it("builds user posts URL", () => {
    expect(buildLessWrongFeedUrl({ view: "userPosts", userId: "abc123" })).toBe(
      "lesswrong://user/abc123"
    );
  });

  it("builds tag posts URL", () => {
    expect(buildLessWrongFeedUrl({ view: "tagRelevance", tagId: "xyz789" })).toBe(
      "lesswrong://tag/xyz789"
    );
  });

  it("throws for userPosts without userId", () => {
    expect(() => buildLessWrongFeedUrl({ view: "userPosts" })).toThrow(
      "userId required for userPosts view"
    );
  });

  it("throws for tagRelevance without tagId", () => {
    expect(() => buildLessWrongFeedUrl({ view: "tagRelevance" })).toThrow(
      "tagId required for tagRelevance view"
    );
  });
});

describe("parseLessWrongFeedUrl", () => {
  it("parses frontpage URL", () => {
    expect(parseLessWrongFeedUrl("lesswrong://frontpage")).toEqual({ view: "frontpage" });
  });

  it("parses curated URL", () => {
    expect(parseLessWrongFeedUrl("lesswrong://curated")).toEqual({ view: "curated" });
  });

  it("parses all posts URL", () => {
    expect(parseLessWrongFeedUrl("lesswrong://all")).toEqual({ view: "all" });
  });

  it("parses user posts URL", () => {
    expect(parseLessWrongFeedUrl("lesswrong://user/abc123")).toEqual({
      view: "userPosts",
      userId: "abc123",
    });
  });

  it("parses tag posts URL", () => {
    expect(parseLessWrongFeedUrl("lesswrong://tag/xyz789")).toEqual({
      view: "tagRelevance",
      tagId: "xyz789",
    });
  });

  it("returns null for non-lesswrong URLs", () => {
    expect(parseLessWrongFeedUrl("https://example.com")).toBeNull();
    expect(parseLessWrongFeedUrl("http://lesswrong.com")).toBeNull();
  });

  it("returns null for invalid lesswrong URLs", () => {
    expect(parseLessWrongFeedUrl("lesswrong://invalid")).toBeNull();
    expect(parseLessWrongFeedUrl("lesswrong://")).toBeNull();
  });
});

describe("URL roundtrip", () => {
  const configs: LessWrongFeedConfig[] = [
    { view: "frontpage" },
    { view: "curated" },
    { view: "all" },
    { view: "userPosts", userId: "user123abc" },
    { view: "tagRelevance", tagId: "tag456def" },
  ];

  for (const config of configs) {
    it(`roundtrips ${config.view}`, () => {
      const url = buildLessWrongFeedUrl(config);
      const parsed = parseLessWrongFeedUrl(url);
      expect(parsed).toEqual(config);
    });
  }
});

describe("isLessWrongFeedUrl", () => {
  it("returns true for valid lesswrong feed URLs", () => {
    expect(isLessWrongFeedUrl("lesswrong://frontpage")).toBe(true);
    expect(isLessWrongFeedUrl("lesswrong://user/abc")).toBe(true);
    expect(isLessWrongFeedUrl("lesswrong://tag/xyz")).toBe(true);
  });

  it("returns false for non-lesswrong URLs", () => {
    expect(isLessWrongFeedUrl("https://lesswrong.com")).toBe(false);
    expect(isLessWrongFeedUrl("lesswrong://invalid")).toBe(false);
    expect(isLessWrongFeedUrl("")).toBe(false);
  });
});

// ============================================================================
// Title Generation
// ============================================================================

describe("getLessWrongFeedTitle", () => {
  it("returns frontpage title", () => {
    expect(getLessWrongFeedTitle({ view: "frontpage" })).toBe("LessWrong - Frontpage");
  });

  it("returns curated title", () => {
    expect(getLessWrongFeedTitle({ view: "curated" })).toBe("LessWrong - Curated");
  });

  it("returns all posts title", () => {
    expect(getLessWrongFeedTitle({ view: "all" })).toBe("LessWrong - All Posts");
  });

  it("returns user posts title with display name", () => {
    expect(getLessWrongFeedTitle({ view: "userPosts", userId: "abc" }, "Eliezer Yudkowsky")).toBe(
      "LessWrong - Eliezer Yudkowsky"
    );
  });

  it("returns generic user posts title without display name", () => {
    expect(getLessWrongFeedTitle({ view: "userPosts", userId: "abc" })).toBe(
      "LessWrong - User Posts"
    );
  });

  it("returns tag posts title with tag name", () => {
    expect(
      getLessWrongFeedTitle({ view: "tagRelevance", tagId: "xyz" }, undefined, "AI Safety")
    ).toBe("LessWrong - AI Safety");
  });

  it("returns generic tag posts title without tag name", () => {
    expect(getLessWrongFeedTitle({ view: "tagRelevance", tagId: "xyz" })).toBe(
      "LessWrong - Tag Posts"
    );
  });
});

// ============================================================================
// Post to Entry Conversion
// ============================================================================

describe("lessWrongPostToParsedEntry", () => {
  const basePost: LessWrongPost = {
    _id: "post123",
    title: "Test Post Title",
    slug: "test-post-title",
    pageUrl: "https://www.lesswrong.com/posts/post123/test-post-title",
    postedAt: "2024-01-15T12:00:00.000Z",
    baseScore: 42,
    curatedDate: null,
    user: {
      _id: "user456",
      displayName: "Test Author",
      username: "testauthor",
    },
    coauthors: null,
    contents: {
      html: "<p>This is the post content.</p>",
    },
  };

  it("converts basic post fields", () => {
    const entry = lessWrongPostToParsedEntry(basePost);

    expect(entry.guid).toBe("post123");
    expect(entry.title).toBe("Test Post Title");
    expect(entry.link).toBe("https://www.lesswrong.com/posts/post123/test-post-title");
    expect(entry.content).toBe("<p>This is the post content.</p>");
    expect(entry.author).toBe("Test Author");
    expect(entry.pubDate).toEqual(new Date("2024-01-15T12:00:00.000Z"));
  });

  it("handles null user gracefully", () => {
    const post = { ...basePost, user: null };
    const entry = lessWrongPostToParsedEntry(post);

    expect(entry.author).toBeUndefined();
  });

  it("uses username as fallback when displayName is null", () => {
    const post = {
      ...basePost,
      user: { _id: "user456", displayName: null, username: "testauthor" },
    };
    const entry = lessWrongPostToParsedEntry(post);

    expect(entry.author).toBe("testauthor");
  });

  it("includes coauthors", () => {
    const post = {
      ...basePost,
      coauthors: [
        { displayName: "Coauthor One", username: "co1" },
        { displayName: null, username: "co2" },
      ],
    };
    const entry = lessWrongPostToParsedEntry(post);

    expect(entry.author).toBe("Test Author, Coauthor One, co2");
  });

  it("handles null content", () => {
    const post = { ...basePost, contents: null };
    const entry = lessWrongPostToParsedEntry(post);

    expect(entry.content).toBeUndefined();
  });

  it("handles null date", () => {
    const post = { ...basePost, postedAt: null };
    const entry = lessWrongPostToParsedEntry(post);

    expect(entry.pubDate).toBeUndefined();
  });

  it("handles null title", () => {
    const post = { ...basePost, title: null };
    const entry = lessWrongPostToParsedEntry(post);

    expect(entry.title).toBeUndefined();
  });

  it("handles null link", () => {
    const post = { ...basePost, pageUrl: null };
    const entry = lessWrongPostToParsedEntry(post);

    expect(entry.link).toBeUndefined();
  });
});

describe("lessWrongPostsToParsedFeed", () => {
  const posts: LessWrongPost[] = [
    {
      _id: "post1",
      title: "First Post",
      slug: "first-post",
      pageUrl: "https://www.lesswrong.com/posts/post1/first-post",
      postedAt: "2024-01-15T12:00:00.000Z",
      baseScore: 10,
      curatedDate: null,
      user: { _id: "u1", displayName: "Author", username: "author" },
      coauthors: null,
      contents: { html: "<p>Content 1</p>" },
    },
    {
      _id: "post2",
      title: "Second Post",
      slug: "second-post",
      pageUrl: "https://www.lesswrong.com/posts/post2/second-post",
      postedAt: "2024-01-16T12:00:00.000Z",
      baseScore: 20,
      curatedDate: null,
      user: { _id: "u2", displayName: "Other", username: "other" },
      coauthors: null,
      contents: { html: "<p>Content 2</p>" },
    },
  ];

  it("converts posts to a ParsedFeed", () => {
    const feed = lessWrongPostsToParsedFeed(posts, "LessWrong - Frontpage");

    expect(feed.title).toBe("LessWrong - Frontpage");
    expect(feed.siteUrl).toBe("https://www.lesswrong.com");
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0].guid).toBe("post1");
    expect(feed.items[1].guid).toBe("post2");
  });

  it("handles empty posts array", () => {
    const feed = lessWrongPostsToParsedFeed([], "LessWrong - Empty");

    expect(feed.title).toBe("LessWrong - Empty");
    expect(feed.items).toHaveLength(0);
  });
});
