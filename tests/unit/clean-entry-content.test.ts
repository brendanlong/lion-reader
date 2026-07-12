/**
 * Unit tests for cleanEntryContent function.
 *
 * Tests content cleaning and summary generation for feed entries,
 * including feed-specific cleaning like LessWrong's "Published on" prefix.
 */

import { describe, it, expect } from "vitest";
import { cleanEntryContent } from "@/server/feed/content-utils";
import type { ParsedEntry } from "@/server/feed/types";

describe("cleanEntryContent", () => {
  describe("LessWrong-style feeds (only summary, no content)", () => {
    const lesswrongFeedUrl = "https://www.lesswrong.com/feed.xml";

    it("strips Published on prefix from summary for LessWrong feeds", () => {
      // LessWrong puts full content in <description> which the RSS parser maps to BOTH
      // content and summary (since there's no content:encoded)
      const descriptionContent =
        "Published on January 7, 2026 2:39 AM GMT<br/><br/><p>I am not an expert on dating. In fact, I am an extremely conservative male.</p>";
      const parsedEntry: ParsedEntry = {
        title: "Algorithmic Dating",
        link: "https://www.lesswrong.com/posts/mLzEWfeSTNFkHW7bX/algorithmic-dating",
        // RSS parser sets both to the same value when there's no content:encoded
        content: descriptionContent,
        summary: descriptionContent,
      };

      const result = cleanEntryContent(parsedEntry, { feedUrl: lesswrongFeedUrl });

      // contentOriginal keeps the original content (with absolutized URLs)
      expect(result.contentOriginal).toContain("Published on");
      expect(result.contentOriginal).toContain("I am not an expert on dating");

      // contentCleaned has the prefix removed
      expect(result.contentCleaned).not.toBeNull();
      expect(result.contentCleaned).not.toContain("Published on");
      expect(result.contentCleaned).toContain("I am not an expert on dating");

      // Summary should NOT contain the Published on prefix (generated from cleaned content)
      // because content === summary, so we treat it as "no separate summary provided"
      expect(result.summary).not.toContain("Published on");
      expect(result.summary).toContain("I am not an expert on dating");
    });

    it("generates summary from cleaned content, not raw summary", () => {
      const descriptionContent =
        "Published on December 25, 2025 11:30 PM EST<br><br><p>The actual article content starts here and continues for a while.</p>";
      const parsedEntry: ParsedEntry = {
        title: "Test Post",
        link: "https://www.lesswrong.com/posts/abc123/test-post",
        // RSS parser sets both to the same value
        content: descriptionContent,
        summary: descriptionContent,
      };

      const result = cleanEntryContent(parsedEntry, { feedUrl: lesswrongFeedUrl });

      // Summary should start with actual content, not "Published on"
      expect(result.summary).toMatch(/^The actual article/);
    });
  });

  describe("feeds with both content and summary", () => {
    it("uses feed-provided summary when both content and summary exist", () => {
      const parsedEntry: ParsedEntry = {
        title: "Article Title",
        link: "https://example.com/article",
        content: "<p>This is the full article content with lots of details.</p>",
        summary: "Brief excerpt from the article.",
      };

      const result = cleanEntryContent(parsedEntry);

      // contentOriginal should be the full content
      expect(result.contentOriginal).toContain("full article content");

      // summary should be derived from the feed-provided summary
      expect(result.summary).toBe("Brief excerpt from the article.");
    });
  });

  describe("feeds with only content (no summary)", () => {
    it("generates summary from content", () => {
      const parsedEntry: ParsedEntry = {
        title: "Article Title",
        link: "https://example.com/article",
        content: "<p>This is the article content that will be used for summary generation.</p>",
        // No summary field
      };

      const result = cleanEntryContent(parsedEntry);

      expect(result.summary).toContain("article content");
    });
  });

  describe("non-LessWrong feeds with only summary", () => {
    it("uses summary as content and generates summary from it", () => {
      const parsedEntry: ParsedEntry = {
        title: "Article Title",
        link: "https://example.com/article",
        summary: "<p>This is a regular feed that only provides description.</p>",
        // No content field
      };

      const result = cleanEntryContent(parsedEntry);

      expect(result.contentOriginal).toContain("regular feed");
      expect(result.summary).toContain("regular feed");
    });
  });
});

describe("YouTube feeds (synthesized content via buildEntryContent)", () => {
  const youtubeFeedUrl = "https://www.youtube.com/feeds/videos.xml?channel_id=UCabc123";

  it("synthesizes embed + description content for entries with no feed content", () => {
    const parsedEntry: ParsedEntry = {
      guid: "yt:video:dQw4w9WgXcQ",
      link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Video Title",
      mediaDescription: "A description of the video.\n\nMore details here.",
    };

    const result = cleanEntryContent(parsedEntry, {
      entryUrl: parsedEntry.link,
      feedUrl: youtubeFeedUrl,
    });

    // No feed-provided content, so original stays null; the synthesized body
    // is the cleaned content.
    expect(result.contentOriginal).toBeNull();
    expect(result.contentCleaned).toContain(
      'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"'
    );
    expect(result.contentCleaned).toContain("A description of the video.");

    // Summary comes from the synthesized content (iframe strips to nothing).
    expect(result.summary).toContain("A description of the video.");
    expect(result.summary).not.toContain("<iframe");
  });

  it("still returns empty results when no video id can be derived", () => {
    const parsedEntry: ParsedEntry = {
      guid: "not-a-video",
      title: "Weird entry",
    };

    const result = cleanEntryContent(parsedEntry, { feedUrl: youtubeFeedUrl });

    expect(result.contentOriginal).toBeNull();
    expect(result.contentCleaned).toBeNull();
    expect(result.summary).toBe("");
  });

  it("does not synthesize content for non-YouTube feeds", () => {
    const parsedEntry: ParsedEntry = {
      guid: "yt:video:dQw4w9WgXcQ",
      link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      mediaDescription: "description",
    };

    const result = cleanEntryContent(parsedEntry, {
      entryUrl: parsedEntry.link,
      feedUrl: "https://example.com/feed.xml",
    });

    expect(result.contentCleaned).toBeNull();
    expect(result.contentOriginal).toBeNull();
  });
});
