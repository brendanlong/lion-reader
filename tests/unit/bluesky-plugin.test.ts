/**
 * Unit tests for the Bluesky plugin. Bluesky's native RSS drops embedded
 * content (quote posts, images, link cards, videos) behind a bare placeholder,
 * so the plugin's `savedArticle` capability hydrates the post via the public
 * AT Protocol appview and renders the text + embeds as clean HTML.
 *
 * These cover the pure functions (URL parsing, rich-text facet rendering, post
 * rendering) against captured API shapes — no network.
 */

import { describe, it, expect } from "vitest";
import {
  blueskyPlugin,
  parseBlueskyPostUrl,
  renderRichText,
  renderBlueskyPostHtml,
  blueskyPostTitle,
} from "@/server/plugins/bluesky";

describe("parseBlueskyPostUrl", () => {
  it("parses a handle-based post URL", () => {
    expect(
      parseBlueskyPostUrl(new URL("https://bsky.app/profile/dresdencodak.com/post/3mqitunm7ic2r"))
    ).toEqual({ identifier: "dresdencodak.com", rkey: "3mqitunm7ic2r" });
  });

  it("parses a DID-based post URL", () => {
    expect(
      parseBlueskyPostUrl(
        new URL("https://bsky.app/profile/did:plc:2u35aiffwimfd4yqfbvexd5o/post/3abc")
      )
    ).toEqual({ identifier: "did:plc:2u35aiffwimfd4yqfbvexd5o", rkey: "3abc" });
  });

  it("returns null for profile, feed, and RSS URLs", () => {
    expect(parseBlueskyPostUrl(new URL("https://bsky.app/profile/alice.bsky.social"))).toBeNull();
    expect(
      parseBlueskyPostUrl(new URL("https://bsky.app/profile/alice.bsky.social/rss"))
    ).toBeNull();
    expect(
      parseBlueskyPostUrl(new URL("https://bsky.app/profile/alice.bsky.social/feed/foo"))
    ).toBeNull();
    expect(parseBlueskyPostUrl(new URL("https://bsky.app/"))).toBeNull();
  });

  it("returns null for non-bsky hosts", () => {
    expect(parseBlueskyPostUrl(new URL("https://example.com/profile/x/post/y"))).toBeNull();
  });

  it("drives matchUrl (posts only)", () => {
    expect(blueskyPlugin.matchUrl(new URL("https://bsky.app/profile/x.com/post/abc"))).toBe(true);
    expect(blueskyPlugin.matchUrl(new URL("https://bsky.app/profile/x.com"))).toBe(false);
    expect(blueskyPlugin.matchUrl(new URL("https://bsky.app/profile/x.com/rss"))).toBe(false);
  });
});

describe("renderRichText", () => {
  it("wraps plain text in a paragraph and escapes HTML, converting newlines to <br>", () => {
    expect(renderRichText("a < b\nc & d", undefined)).toBe("<p>a &lt; b<br>c &amp; d</p>");
  });

  it("renders a link facet using UTF-8 byte offsets (past a multibyte emoji)", () => {
    // Bytes: "hi " = 0..3, "😀" = 3..7, " " = 7..8, "link" = 8..12
    const text = "hi 😀 link";
    const html = renderRichText(text, [
      {
        index: { byteStart: 8, byteEnd: 12 },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/x" }],
      },
    ]);
    expect(html).toBe('<p>hi 😀 <a href="https://example.com/x">link</a></p>');
  });

  it("renders mention and tag facets as bsky.app links", () => {
    // "@bob #cats" — "@bob" = bytes 0..4, "#cats" = bytes 5..10
    const html = renderRichText("@bob #cats", [
      {
        index: { byteStart: 0, byteEnd: 4 },
        features: [{ $type: "app.bsky.richtext.facet#mention", did: "did:plc:bob" }],
      },
      {
        index: { byteStart: 5, byteEnd: 10 },
        features: [{ $type: "app.bsky.richtext.facet#tag", tag: "cats" }],
      },
    ]);
    expect(html).toContain('<a href="https://bsky.app/profile/did:plc:bob">@bob</a>');
    expect(html).toContain('<a href="https://bsky.app/hashtag/cats">#cats</a>');
  });

  it("drops non-http link schemes (defense in depth)", () => {
    const html = renderRichText("click", [
      {
        index: { byteStart: 0, byteEnd: 5 },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: "javascript:alert(1)" }],
      },
    ]);
    expect(html).toBe("<p>click</p>");
  });

  it("skips out-of-range and overlapping facets", () => {
    const html = renderRichText("short", [
      {
        index: { byteStart: 0, byteEnd: 999 },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: "https://example.com" }],
      },
    ]);
    expect(html).toBe("<p>short</p>");
  });
});

describe("renderBlueskyPostHtml", () => {
  const author = {
    did: "did:plc:sen",
    handle: "dresdencodak.com",
    displayName: "Sen",
  };

  it("renders a quote post with a nested image (record#view)", () => {
    const post = {
      uri: "at://did:plc:sen/app.bsky.feed.post/3mqitunm7ic2r",
      author,
      record: {
        $type: "app.bsky.feed.post",
        text: "The cookout was a success",
        createdAt: "2026-07-13T04:23:53.069Z",
      },
      embed: {
        $type: "app.bsky.embed.record#view",
        record: {
          $type: "app.bsky.embed.record#viewRecord",
          uri: "at://did:plc:sen/app.bsky.feed.post/3mpyuvsp7wc2g",
          author: { did: "did:plc:sen", handle: "dresdencodak.com", displayName: "Sen" },
          value: { $type: "app.bsky.feed.post", text: "Community Cookout!" },
          embeds: [
            {
              $type: "app.bsky.embed.images#view",
              images: [
                {
                  thumb: "https://cdn.bsky.app/thumb.jpg",
                  fullsize: "https://cdn.bsky.app/full.jpg",
                  alt: "A flyer",
                },
              ],
            },
          ],
        },
      },
    };
    const html = renderBlueskyPostHtml(
      post,
      "https://bsky.app/profile/dresdencodak.com/post/3mqitunm7ic2r"
    );
    expect(html).toContain("<p>The cookout was a success</p>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("Community Cookout!");
    expect(html).toContain('<img src="https://cdn.bsky.app/full.jpg" alt="A flyer"');
    expect(html).toContain("<figcaption>A flyer</figcaption>");
    // quoted author is cited with a link to its own post
    expect(html).toContain(
      '<cite><a href="https://bsky.app/profile/dresdencodak.com/post/3mpyuvsp7wc2g">Sen</a></cite>'
    );
  });

  it("renders an external link card", () => {
    const post = {
      uri: "at://did:plc:sen/app.bsky.feed.post/x",
      author,
      record: { $type: "app.bsky.feed.post", text: "read this" },
      embed: {
        $type: "app.bsky.embed.external#view",
        external: {
          uri: "https://example.com/article",
          title: "An Article",
          description: "About things",
          thumb: "https://cdn.bsky.app/card.jpg",
        },
      },
    };
    const html = renderBlueskyPostHtml(post, "https://bsky.app/profile/x/post/x");
    expect(html).toContain('<a href="https://example.com/article">');
    expect(html).toContain("<strong>An Article</strong>");
    expect(html).toContain("<figcaption>About things</figcaption>");
  });

  it("renders recordWithMedia (media + nested quote)", () => {
    const post = {
      uri: "at://did:plc:sen/app.bsky.feed.post/x",
      author,
      record: { $type: "app.bsky.feed.post", text: "both" },
      embed: {
        $type: "app.bsky.embed.recordWithMedia#view",
        media: {
          $type: "app.bsky.embed.images#view",
          images: [{ fullsize: "https://cdn.bsky.app/m.jpg", alt: "media" }],
        },
        record: {
          record: {
            $type: "app.bsky.embed.record#viewRecord",
            uri: "at://did:plc:other/app.bsky.feed.post/q",
            author: { did: "did:plc:other", handle: "other.bsky.social" },
            value: { $type: "app.bsky.feed.post", text: "quoted here" },
          },
        },
      },
    };
    const html = renderBlueskyPostHtml(post, "https://bsky.app/profile/x/post/x");
    expect(html).toContain('<img src="https://cdn.bsky.app/m.jpg" alt="media"');
    expect(html).toContain("quoted here");
    expect(html).toContain("@other.bsky.social");
  });

  it("renders a not-found quote gracefully", () => {
    const post = {
      uri: "at://did:plc:sen/app.bsky.feed.post/x",
      author,
      record: { $type: "app.bsky.feed.post", text: "gone" },
      embed: {
        $type: "app.bsky.embed.record#view",
        record: { $type: "app.bsky.embed.record#viewNotFound", uri: "at://x" },
      },
    };
    const html = renderBlueskyPostHtml(post, "https://bsky.app/profile/x/post/x");
    expect(html).toContain("<p>gone</p>");
    expect(html).toContain("[Quoted post not found]");
  });
});

describe("blueskyPostTitle", () => {
  const author = { did: "did:plc:sen", handle: "dresdencodak.com", displayName: "Sen" };

  it("uses the first line of text", () => {
    expect(
      blueskyPostTitle({
        uri: "at://x",
        author,
        record: { text: "First line\nsecond line" },
      })
    ).toBe("First line");
  });

  it("truncates long single lines", () => {
    const long = "x".repeat(150);
    const title = blueskyPostTitle({ uri: "at://x", author, record: { text: long } });
    expect(title.length).toBe(100);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to the author when there is no text", () => {
    expect(blueskyPostTitle({ uri: "at://x", author, record: { text: "" } })).toBe("Post by Sen");
  });
});
