/**
 * Unit tests for the YouTube plugin's `feed` capability and the `getFeedPlugin`
 * resolver. The plugin floors YouTube's aggressive `max-age=900` cache hint at
 * an hour so we don't trip YouTube's per-IP rate limiting (issue #1114), and
 * synthesizes entry content (embedded player + description) from the feed's
 * Media RSS metadata (issue #1115). Also covers the shared YouTube URL helpers
 * and the guard that keeps the synthesized embed acceptable to the sanitizer.
 */

import { describe, it, expect } from "vitest";
import {
  youtubePlugin,
  synthesizeYouTubeSavedArticle,
  YOUTUBE_MIN_FETCH_INTERVAL_SECONDS,
} from "@/server/plugins/youtube";
import { getFeedPlugin } from "@/server/plugins";
import { extractYouTubeVideoId } from "@/server/html/youtube-embed";
import { normalizeEmbed, sanitizeEntryHtml } from "@lion-reader/sanitizer";
import type { ParsedEntry } from "@/server/feed/types";

/** What the sanitizer forces on a YouTube embed — the single source of truth. */
const YOUTUBE_EMBED = normalizeEmbed("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")!;

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

  it("matches video-page URLs (handled by the savedArticle capability)", () => {
    expect(youtubePlugin.matchUrl(new URL("https://www.youtube.com/watch?v=dQw4w9WgXcQ"))).toBe(
      true
    );
    expect(youtubePlugin.matchUrl(new URL("https://youtu.be/dQw4w9WgXcQ"))).toBe(true);
    expect(youtubePlugin.matchUrl(new URL("https://www.youtube.com/shorts/dQw4w9WgXcQ"))).toBe(
      true
    );
  });

  it("does not match channel/other non-video pages or a bare feed URL", () => {
    expect(youtubePlugin.matchUrl(new URL("https://www.youtube.com/@somechannel"))).toBe(false);
    expect(youtubePlugin.matchUrl(new URL("https://www.youtube.com/feeds/videos.xml"))).toBe(false);
    expect(youtubePlugin.matchUrl(new URL("https://www.youtube.com/watch?v=notanid!"))).toBe(false);
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

  it("resolves video-page URLs but exposes no page→feed transform for them", () => {
    // matchUrl now also matches video pages (for the savedArticle capability),
    // so getFeedPlugin resolves the plugin — but the feed sub-capabilities used
    // on page URLs (transformToFeedUrl, cleanEntryContent) are undefined, so
    // treating a watch URL as a feed source is a no-op.
    const plugin = getFeedPlugin("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(plugin?.name).toBe("youtube");
    expect(plugin?.capabilities.feed.transformToFeedUrl).toBeUndefined();
    expect(plugin?.capabilities.feed.cleanEntryContent).toBeUndefined();
  });

  it("does not resolve non-video YouTube pages", () => {
    expect(getFeedPlugin("https://www.youtube.com/@somechannel")).toBeNull();
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

describe("synthesizeYouTubeSavedArticle", () => {
  // A minimal watch-page stand-in with the metadata the extractor reads: the
  // Open Graph title/description, the microdata author, and the full
  // player-JSON description (whose newlines survive JSON-parsing).
  const watchPageHtml = (opts: {
    title?: string;
    author?: string;
    ogDescription?: string;
    shortDescription?: string;
  }) => {
    const parts: string[] = ["<html><head>"];
    if (opts.title) parts.push(`<meta property="og:title" content="${opts.title}">`);
    if (opts.ogDescription)
      parts.push(`<meta property="og:description" content="${opts.ogDescription}">`);
    parts.push('<span itemprop="author">');
    if (opts.author) parts.push(`<link itemprop="name" content="${opts.author}">`);
    parts.push("</span></head><body>");
    if (opts.shortDescription !== undefined) {
      parts.push(
        `<script>var x = {"shortDescription":${JSON.stringify(opts.shortDescription)}};</script>`
      );
    }
    parts.push("</body></html>");
    return parts.join("");
  };

  it("synthesizes an embed plus title, author, and full description", () => {
    const result = synthesizeYouTubeSavedArticle(
      "dQw4w9WgXcQ",
      watchPageHtml({
        title: "Rick Astley - Never Gonna Give You Up",
        author: "Rick Astley",
        ogDescription: "Truncated…",
        shortDescription: "The official video.\n\nSecond paragraph with https://example.com/link",
      })
    );

    expect(result.html).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
    expect(result.html).toContain('title="Rick Astley - Never Gonna Give You Up"');
    // Prefers the full shortDescription over the truncated og:description.
    expect(result.html).toContain("<p>The official video.</p>");
    expect(result.html).toContain('<a href="https://example.com/link">');
    expect(result.html).not.toContain("Truncated");
    expect(result.title).toBe("Rick Astley - Never Gonna Give You Up");
    expect(result.author).toBe("Rick Astley");
    expect(result.canonicalUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("falls back to og:description when no player JSON is present", () => {
    const result = synthesizeYouTubeSavedArticle(
      "dQw4w9WgXcQ",
      watchPageHtml({ title: "Title", ogDescription: "A short description." })
    );
    expect(result.html).toContain("<p>A short description.</p>");
  });

  it("escapes an XSS attempt in the title attribute", () => {
    const result = synthesizeYouTubeSavedArticle(
      "dQw4w9WgXcQ",
      watchPageHtml({ title: '"><script>alert(1)</script>' })
    );
    expect(result.html).not.toContain("<script>");
  });

  it("produces a working embed with no description when metadata is missing", () => {
    const result = synthesizeYouTubeSavedArticle("dQw4w9WgXcQ", "<html></html>");
    expect(result.html).toContain("/embed/dQw4w9WgXcQ");
    expect(result.html).not.toContain("<p>");
    expect(result.title).toBeNull();
    expect(result.author).toBeNull();
  });

  it("produces a titleless embed when the watch page couldn't be fetched", () => {
    const result = synthesizeYouTubeSavedArticle("dQw4w9WgXcQ", null);
    expect(result.html).toBe(
      `<iframe src="${YOUTUBE_EMBED.src}"` +
        ' width="560" height="315"' +
        ` sandbox="${YOUTUBE_EMBED.sandbox}" allow="${YOUTUBE_EMBED.allow}"` +
        ' allowfullscreen loading="lazy"></iframe>'
    );
    expect(result.title).toBeNull();
  });
});

/**
 * The plugin stores raw HTML and every read re-runs the sanitizer over it, so
 * an embed the sanitizer drops is an embed users never see. These are the
 * guard `src/server/html/CLAUDE.md` promises: a tightening of the Rust
 * allow-list that would blank YouTube entries fails here instead.
 */
describe("synthesized embeds survive the sanitizer", () => {
  it("keeps the src, sandbox, allow, and player attributes intact", () => {
    const raw = synthesizeYouTubeSavedArticle("dQw4w9WgXcQ", null).html;
    const { html } = sanitizeEntryHtml(raw);

    // Redundant while the builder derives these from `normalizeEmbed` — which
    // is the point: they fail the moment someone hand-writes them back in.
    expect(raw).toContain(`src="${YOUTUBE_EMBED.src}"`);
    expect(raw).toContain(`sandbox="${YOUTUBE_EMBED.sandbox}"`);
    expect(raw).toContain(`allow="${YOUTUBE_EMBED.allow}"`);

    expect(html).toContain("<iframe");
    expect(html).toContain(`src="${YOUTUBE_EMBED.src}"`);
    expect(html).toContain(`sandbox="${YOUTUBE_EMBED.sandbox}"`);
    expect(html).toContain(`allow="${YOUTUBE_EMBED.allow}"`);
    expect(html).toContain('width="560"');
    expect(html).toContain('height="315"');
    expect(html).toContain("allowfullscreen");
    expect(html).toContain('loading="lazy"');
  });

  it("keeps the title attribute of a feed-synthesized embed", () => {
    const raw = youtubePlugin.capabilities.feed!.buildEntryContent!(
      { guid: "yt:video:dQw4w9WgXcQ", title: "Video Title" },
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    );
    const { html } = sanitizeEntryHtml(raw!);
    expect(html).toContain('title="Video Title"');
    expect(html).toContain(`src="${YOUTUBE_EMBED.src}"`);
  });
});
