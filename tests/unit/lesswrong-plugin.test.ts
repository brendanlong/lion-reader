/**
 * Unit tests for the LessWrong plugin's `feed` capability and the `getFeedPlugin`
 * resolver. These cover the pure (non-network) behavior that the feed-processing
 * path relies on.
 */

import { describe, it, expect } from "vitest";
import { lessWrongPlugin } from "@/server/plugins/lesswrong";
import { getFeedPlugin } from "@/server/plugins";
import {
  LESSWRONG_FRONTPAGE_FEED_URL,
  LESSWRONG_SHORTFORM_FRONTPAGE_FEED_URL,
} from "@/server/feed/lesswrong";

const feed = lessWrongPlugin.capabilities.feed!;

describe("lessWrongPlugin.matchUrl", () => {
  it("matches LessWrong URLs it knows how to handle (feeds and mappable pages)", () => {
    expect(lessWrongPlugin.matchUrl(new URL("https://www.lesswrong.com/"))).toBe(true);
    expect(lessWrongPlugin.matchUrl(new URL("https://www.lesswrong.com/quicktakes"))).toBe(true);
    expect(lessWrongPlugin.matchUrl(new URL("https://www.lesswrong.com/feed.xml?userId=abc"))).toBe(
      true
    );
    expect(lessWrongPlugin.matchUrl(new URL("https://www.lesswrong.com/users/brendan-long"))).toBe(
      true
    );
    expect(
      lessWrongPlugin.matchUrl(new URL("https://www.lesswrong.com/posts/mLzEWfeSTNFkHW7bX/slug"))
    ).toBe(true);
  });

  it("does not match unknown LessWrong pages (fetched normally instead)", () => {
    expect(lessWrongPlugin.matchUrl(new URL("https://www.lesswrong.com/tag/rationality"))).toBe(
      false
    );
    expect(lessWrongPlugin.matchUrl(new URL("https://www.lesswrong.com/library"))).toBe(false);
  });
});

describe("lessWrongPlugin feed.cleanEntryContent", () => {
  it("strips the 'Published on' prefix", () => {
    const html = "Published on January 7, 2026 2:39 AM GMT<br/><br/><p>Article body.</p>";
    expect(feed.cleanEntryContent?.(html)).toBe("<p>Article body.</p>");
  });

  it("leaves non-prefixed content unchanged", () => {
    const html = "<p>No prefix here.</p>";
    expect(feed.cleanEntryContent?.(html)).toBe(html);
  });
});

describe("lessWrongPlugin feed.transformFeedTitle", () => {
  const userFeedUrl = new URL("https://www.lesswrong.com/feed.xml?userId=piR3ZKGHEp6vqTo87");

  it("appends the first author for user feeds", () => {
    expect(
      feed.transformFeedTitle?.("LessWrong", userFeedUrl, { firstAuthor: "Brendan Long" })
    ).toBe("LessWrong - Brendan Long");
  });

  it("does not duplicate an author already in the title", () => {
    expect(
      feed.transformFeedTitle?.("LessWrong - Brendan Long", userFeedUrl, {
        firstAuthor: "Brendan Long",
      })
    ).toBe("LessWrong - Brendan Long");
  });

  it("returns the title unchanged when no author is available", () => {
    expect(feed.transformFeedTitle?.("LessWrong", userFeedUrl, { firstAuthor: null })).toBe(
      "LessWrong"
    );
  });

  it("leaves non-user feeds untouched", () => {
    const frontpageUrl = new URL(LESSWRONG_FRONTPAGE_FEED_URL);
    expect(feed.transformFeedTitle?.("LessWrong", frontpageUrl, { firstAuthor: "Someone" })).toBe(
      "LessWrong"
    );
  });
});

describe("lessWrongPlugin feed.transformToFeedUrl", () => {
  it("maps the front page to the frontpage feed", async () => {
    const result = await feed.transformToFeedUrl?.(new URL("https://www.lesswrong.com/"));
    expect(result?.href).toBe(LESSWRONG_FRONTPAGE_FEED_URL);
  });

  it("maps the quicktakes page to the shortform frontpage feed", async () => {
    const result = await feed.transformToFeedUrl?.(new URL("https://www.lesswrong.com/quicktakes"));
    expect(result?.href).toBe(LESSWRONG_SHORTFORM_FRONTPAGE_FEED_URL);
  });
});

describe("getFeedPlugin", () => {
  it("resolves the LessWrong plugin for LessWrong feed URLs", () => {
    expect(getFeedPlugin("https://www.lesswrong.com/feed.xml?userId=abc")?.name).toBe("lesswrong");
  });

  it("returns null for hosts with no feed plugin", () => {
    expect(getFeedPlugin("https://example.com/feed.xml")).toBeNull();
  });

  it("returns null for invalid or missing URLs", () => {
    expect(getFeedPlugin("not-a-url")).toBeNull();
    expect(getFeedPlugin(null)).toBeNull();
    expect(getFeedPlugin(undefined)).toBeNull();
  });
});
