/**
 * Unit tests for getFeedHooks: the plugin feed hooks every feed-processing
 * caller (fetch, preview, subscribe) goes through, and their fallback when a
 * plugin throws.
 */

import { describe, it, expect } from "vitest";
import { getFeedHooks, pluginRegistry } from "../../src/server/plugins";
import type { ParsedEntry } from "../../src/server/feed/types";

const LESSWRONG_USER_FEED = "https://www.lesswrong.com/feed.xml?userId=piR3ZKGHEp6vqTo87";
const THROWING_FEED = "https://throwing-plugin.invalid/feed.xml";

const boom = (): never => {
  throw new Error("boom");
};
pluginRegistry.register({
  name: "throwing",
  hosts: ["throwing-plugin.invalid"],
  matchUrl: () => true,
  capabilities: {
    feed: { transformFeedTitle: boom, cleanEntryContent: boom, buildEntryContent: boom },
  },
});

const video: ParsedEntry = {
  guid: "yt:video:dQw4w9WgXcQ",
  link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  title: "Video Title",
};

describe("getFeedHooks", () => {
  it("passes the first entry author to the plugin's title transform", () => {
    const items: ParsedEntry[] = [{ title: "No author" }, { author: "Brendan Long" }];
    expect(getFeedHooks(LESSWRONG_USER_FEED).resolveFeedTitle({ title: "LessWrong", items })).toBe(
      "LessWrong - Brendan Long"
    );
  });

  it("falls back to the stored title, then the transformed hostname", () => {
    const hooks = getFeedHooks(LESSWRONG_USER_FEED);
    const items: ParsedEntry[] = [{ author: "Brendan Long" }];
    expect(hooks.resolveFeedTitle({ title: "", items }, "LessWrong - Brendan Long")).toBe(
      "LessWrong - Brendan Long"
    );
    expect(hooks.resolveFeedTitle({ items }, null)).toBe("www.lesswrong.com - Brendan Long");
    expect(getFeedHooks(null).resolveFeedTitle({ items })).toBeNull();
  });

  it("is a no-op for a feed no plugin handles, or no URL", () => {
    for (const hooks of [getFeedHooks("https://example.com/feed.xml"), getFeedHooks(null)]) {
      expect(hooks.resolveFeedTitle({ title: "Title", items: [{ author: "A" }] })).toBe("Title");
      expect(hooks.cleanEntryContent("<p>x</p>")).toBe("<p>x</p>");
      expect(hooks.buildEntryContent(video, video.link)).toBeNull();
    }
  });

  it("falls back to the unplugged result when the plugin throws", () => {
    const hooks = getFeedHooks(THROWING_FEED);
    expect(hooks.resolveFeedTitle({ title: "Title", items: [{ author: "A" }] })).toBe("Title");
    expect(hooks.cleanEntryContent("<p>x</p>")).toBe("<p>x</p>");
    expect(hooks.buildEntryContent(video, video.link)).toBeNull();
  });
});
