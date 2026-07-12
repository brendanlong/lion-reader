/**
 * Unit tests for the YouTube plugin's `feed` capability and the `getFeedPlugin`
 * resolver. The plugin floors YouTube's aggressive `max-age=900` cache hint at
 * an hour so we don't trip YouTube's per-IP rate limiting (issue #1114), and
 * synthesizes entry content (embedded player + description) from the feed's
 * Media RSS metadata (issue #1115). Also covers the shared YouTube embed URL
 * helpers used by the sanitizer.
 */

import { describe, it, expect } from "vitest";
import {
  youtubePlugin,
  youtubeDescriptionToHtml,
  YOUTUBE_MIN_FETCH_INTERVAL_SECONDS,
} from "@/server/plugins/youtube";
import { getFeedPlugin } from "@/server/plugins";
import { extractYouTubeVideoId, normalizeYouTubeEmbedUrl } from "@/server/html/youtube-embed";
import type { ParsedEntry } from "@/server/feed/types";

describe("youtubePlugin.matchUrl", () => {
  it("matches channel, playlist, and legacy user feed URLs", () => {
    expect(
      youtubePlugin.matchUrl(
        new URL("https://www.youtube.com/feeds/videos.xml?channel_id=UCXuqSBlHAE6Xw-yeJA0Tunw")
      )
    ).toBe(true);
    expect(
      youtubePlugin.matchUrl(
        new URL("https://www.youtube.com/feeds/videos.xml?playlist_id=PL1234567890")
      )
    ).toBe(true);
    expect(
      youtubePlugin.matchUrl(new URL("https://www.youtube.com/feeds/videos.xml?user=somename"))
    ).toBe(true);
  });

  it("does not match non-feed YouTube URLs", () => {
    expect(youtubePlugin.matchUrl(new URL("https://www.youtube.com/watch?v=abc123"))).toBe(false);
    expect(youtubePlugin.matchUrl(new URL("https://www.youtube.com/@somechannel"))).toBe(false);
    expect(youtubePlugin.matchUrl(new URL("https://www.youtube.com/feeds/videos.xml"))).toBe(false);
  });
});

describe("getFeedPlugin resolution for YouTube", () => {
  it("resolves YouTube feed URLs to the plugin with the polling floor", () => {
    const plugin = getFeedPlugin(
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCXuqSBlHAE6Xw-yeJA0Tunw"
    );
    expect(plugin?.name).toBe("youtube");
    expect(plugin?.capabilities.feed.minFetchIntervalSeconds).toBe(
      YOUTUBE_MIN_FETCH_INTERVAL_SECONDS
    );
  });

  it("resolves the bare and mobile hostnames too", () => {
    expect(getFeedPlugin("https://youtube.com/feeds/videos.xml?channel_id=UCabc")?.name).toBe(
      "youtube"
    );
    expect(getFeedPlugin("https://m.youtube.com/feeds/videos.xml?channel_id=UCabc")?.name).toBe(
      "youtube"
    );
  });

  it("does not resolve non-feed YouTube URLs", () => {
    expect(getFeedPlugin("https://www.youtube.com/watch?v=abc123")).toBeNull();
  });
});

describe("normalizeYouTubeEmbedUrl", () => {
  it("rewrites youtube.com embeds to www.youtube-nocookie.com", () => {
    expect(normalizeYouTubeEmbedUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
    );
    expect(normalizeYouTubeEmbedUrl("https://youtube.com/embed/dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
    );
  });

  it("accepts protocol-relative srcs", () => {
    expect(normalizeYouTubeEmbedUrl("//www.youtube-nocookie.com/embed/dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
    );
  });

  it("keeps only allow-listed query params", () => {
    expect(
      normalizeYouTubeEmbedUrl(
        "https://www.youtube.com/embed/dQw4w9WgXcQ?start=30&autoplay=1&enablejsapi=1&origin=https%3A%2F%2Fevil.com"
      )
    ).toBe("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=30");
  });

  it("rejects non-embed and non-YouTube URLs", () => {
    expect(normalizeYouTubeEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(normalizeYouTubeEmbedUrl("https://evil.com/embed/dQw4w9WgXcQ")).toBeNull();
    expect(normalizeYouTubeEmbedUrl("https://www.youtube.com.evil.com/embed/x")).toBeNull();
    expect(normalizeYouTubeEmbedUrl("https://www.youtube.com/embed/a/b")).toBeNull();
    expect(normalizeYouTubeEmbedUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeYouTubeEmbedUrl(null)).toBeNull();
    expect(normalizeYouTubeEmbedUrl("")).toBeNull();
  });
});

describe("extractYouTubeVideoId", () => {
  it("extracts from the URL forms YouTube uses", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ"
    );
    expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractYouTubeVideoId("https://m.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  it("returns null for non-video URLs", () => {
    expect(extractYouTubeVideoId("https://www.youtube.com/@somechannel")).toBeNull();
    expect(extractYouTubeVideoId("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(extractYouTubeVideoId("not a url")).toBeNull();
    expect(extractYouTubeVideoId(undefined)).toBeNull();
  });
});

describe("youtubeDescriptionToHtml", () => {
  it("escapes HTML in the description", () => {
    expect(youtubeDescriptionToHtml("a <script>alert(1)</script> & b")).toBe(
      "<p>a &lt;script&gt;alert(1)&lt;/script&gt; &amp; b</p>"
    );
  });

  it("splits paragraphs on blank lines and lines on single newlines", () => {
    expect(youtubeDescriptionToHtml("para one\nline two\n\npara two")).toBe(
      "<p>para one<br>line two</p><p>para two</p>"
    );
  });

  it("links bare URLs, trimming trailing punctuation", () => {
    expect(youtubeDescriptionToHtml("See https://example.com/page. Done")).toBe(
      '<p>See <a href="https://example.com/page">https://example.com/page</a>. Done</p>'
    );
    expect(youtubeDescriptionToHtml("(see https://example.com/page)")).toBe(
      '<p>(see <a href="https://example.com/page">https://example.com/page</a>)</p>'
    );
  });

  it("keeps escaped query separators in linked URLs", () => {
    expect(youtubeDescriptionToHtml("https://example.com/x?a=1&b=2")).toBe(
      '<p><a href="https://example.com/x?a=1&amp;b=2">https://example.com/x?a=1&amp;b=2</a></p>'
    );
  });
});

describe("youtubePlugin buildEntryContent", () => {
  const buildEntryContent = youtubePlugin.capabilities.feed!.buildEntryContent!;

  const entry = (overrides: Partial<ParsedEntry> = {}): ParsedEntry => ({
    guid: "yt:video:dQw4w9WgXcQ",
    link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    title: "Video Title",
    mediaDescription: "First line.\n\nSecond paragraph with https://example.com/link",
    ...overrides,
  });

  it("builds an embed iframe plus the description", () => {
    const html = buildEntryContent(entry(), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(html).toContain("sandbox=");
    expect(html).toContain('title="Video Title"');
    expect(html).toContain("<p>First line.</p>");
    expect(html).toContain('<a href="https://example.com/link">');
  });

  it("falls back to the yt:video guid when there is no usable URL", () => {
    const html = buildEntryContent(entry(), undefined);
    expect(html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
  });

  it("returns null when no video id can be derived", () => {
    expect(buildEntryContent(entry({ guid: "something-else" }), undefined)).toBeNull();
  });

  it("builds the embed alone when there is no description", () => {
    const html = buildEntryContent(
      entry({ mediaDescription: undefined }),
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    );
    expect(html).toContain("<iframe");
    expect(html).not.toContain("<p>");
  });

  it("escapes HTML in the title attribute", () => {
    const html = buildEntryContent(
      entry({ title: '"><script>alert(1)</script>' }),
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    );
    expect(html).not.toContain("<script>");
  });
});
