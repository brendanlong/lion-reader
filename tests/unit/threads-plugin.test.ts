/**
 * Unit tests for the Threads plugin. The official API can't read other users'
 * public posts without Meta App Review, and the token-free oEmbed endpoint
 * returns only the JS placeholder blockquote — but the post page serves the
 * complete post text in `og:description`, which is what the plugin renders.
 *
 * These cover the pure functions (URL parsing, page rendering) against captured
 * page shapes — no network.
 */

import { describe, it, expect } from "vitest";
import {
  threadsPlugin,
  parseThreadsPostCode,
  parseThreadsAuthor,
  renderThreadsPost,
} from "@/server/plugins/threads";

const POST_URL = "https://www.threads.com/@anujs3/post/DNG2tXiBjzN";

/** A minimal post page carrying the Open Graph tags Threads actually serves. */
function page(
  options: {
    title?: string | null;
    description?: string | null;
    image?: string | null;
    /** Threads sends `summary` for a text post, `summary_large_image` with media. */
    card?: string | null;
  } = {}
): string {
  const {
    title = "Anuj Shah (@anujs3) on Threads",
    description = "Post body.",
    image = "https://scontent.cdninstagram.com/v/t51.2885-19/avatar.jpg",
    card = "summary",
  } = options;
  return [
    "<html><head>",
    '<meta property="og:site_name" content="Threads" />',
    title === null ? "" : `<meta property="og:title" content="${title}" />`,
    description === null ? "" : `<meta property="og:description" content="${description}" />`,
    image === null ? "" : `<meta property="og:image" content="${image}" />`,
    card === null ? "" : `<meta name="twitter:card" content="${card}" />`,
    '<meta name="twitter:description" content="Post body, but elided at..." />',
    "</head><body></body></html>",
  ].join("");
}

/** The og:image on a post with real media, shaped like the live ones. */
const MEDIA_IMAGE = "https://scontent-sea5-1.cdninstagram.com/v/t51.82787-15/comic.webp";

describe("parseThreadsPostCode", () => {
  it("parses the canonical post URL", () => {
    expect(parseThreadsPostCode(new URL(POST_URL))).toBe("DNG2tXiBjzN");
  });

  it("parses a post URL with the SEO slug Threads appends", () => {
    expect(
      parseThreadsPostCode(new URL(`${POST_URL}/you-can-still-call-the-keyword-search-api`))
    ).toBe("DNG2tXiBjzN");
  });

  it("parses the /t/ short permalink used by embeds", () => {
    expect(parseThreadsPostCode(new URL("https://www.threads.com/t/DNG2tXiBjzN"))).toBe(
      "DNG2tXiBjzN"
    );
  });

  // What the Threads app's share sheet produces, so it's the form most likely
  // to be pasted into the app. Its id lives in its own space, not the post's
  // shortcode space, and it 302s to the canonical URL.
  it("parses the /share/ form the app's share sheet produces", () => {
    for (const href of [
      "https://www.threads.com/share/BAd-r4UCHz/",
      "https://www.threads.com/share/BAd-r4UCHz",
      "https://threads.com/share/BAd-r4UCHz",
      "https://www.threads.net/share/BAd-r4UCHz/",
    ]) {
      expect(parseThreadsPostCode(new URL(href))).toBe("BAd-r4UCHz");
    }
  });

  it("drives matchUrl for every form Threads hands out", () => {
    for (const href of [
      "https://www.threads.com/@smbccomics/post/DbYcIlkj-Pv",
      "https://www.threads.com/t/DbYcIlkj-Pv",
      "https://www.threads.com/share/BAd-r4UCHz/",
    ]) {
      expect(threadsPlugin.matchUrl(new URL(href))).toBe(true);
    }
  });

  it("handles both the threads.com and threads.net domains, with or without www", () => {
    for (const host of ["threads.com", "www.threads.com", "threads.net", "www.threads.net"]) {
      expect(parseThreadsPostCode(new URL(`https://${host}/@anujs3/post/DNG2tXiBjzN`))).toBe(
        "DNG2tXiBjzN"
      );
    }
  });

  it("returns null for profiles, tags, and search", () => {
    for (const path of ["/@anujs3", "/", "/search?q=x", "/@anujs3/replies", "/tag/threads"]) {
      expect(parseThreadsPostCode(new URL(`https://www.threads.com${path}`))).toBeNull();
    }
  });

  // fetchContent guards against redirects with this: a deleted or invalid post
  // redirects here, and the home page carries its own og:description that would
  // otherwise be saved as the post body.
  it("returns null for the home page a dead post redirects to", () => {
    expect(parseThreadsPostCode(new URL("https://www.threads.com/?error=invalid_post"))).toBeNull();
  });

  it("returns null for non-Threads hosts", () => {
    expect(parseThreadsPostCode(new URL("https://example.com/@a/post/b"))).toBeNull();
  });

  it("drives matchUrl (posts only)", () => {
    expect(threadsPlugin.matchUrl(new URL(POST_URL))).toBe(true);
    expect(threadsPlugin.matchUrl(new URL("https://www.threads.com/@anujs3"))).toBe(false);
  });

  // See the LinkedIn equivalent: matchUrl runs outside the try that wraps
  // fetchContent, so a throw here is a 500 on save rather than a fallback.
  it("does not throw on a malformed percent-escape", () => {
    for (const path of ["/%", "/@a/post/%E0%A4%A", "/t/%ZZ"]) {
      expect(() => threadsPlugin.matchUrl(new URL(`https://www.threads.com${path}`))).not.toThrow();
    }
  });
});

describe("parseThreadsAuthor", () => {
  it("strips the ' on Threads' suffix", () => {
    expect(parseThreadsAuthor("Anuj Shah (@anujs3) on Threads")).toBe("Anuj Shah (@anujs3)");
  });

  it("passes through a title that doesn't match the expected shape", () => {
    expect(parseThreadsAuthor("Something else")).toBe("Something else");
  });

  it("returns null when there is no title", () => {
    expect(parseThreadsAuthor(null)).toBeNull();
    expect(parseThreadsAuthor("  on Threads")).toBeNull();
  });
});

describe("renderThreadsPost", () => {
  it("renders the post text with author and a first-line title", () => {
    const result = renderThreadsPost(
      page({ description: "First line of the post.\n\nSecond paragraph." }),
      POST_URL
    );

    expect(result).not.toBeNull();
    expect(result!.html).toBe("<p>First line of the post.</p><p>Second paragraph.</p>");
    expect(result!.title).toBe("First line of the post.");
    expect(result!.author).toBe("Anuj Shah (@anujs3)");
    expect(result!.canonicalUrl).toBe(POST_URL);
  });

  it("escapes HTML and links bare URLs in the post text", () => {
    const result = renderThreadsPost(
      page({ description: "See https://example.com/x &amp; <b>this</b>" }),
      POST_URL
    );
    expect(result!.html).toBe(
      '<p>See <a href="https://example.com/x">https://example.com/x</a> &amp; ' +
        "&lt;b&gt;this&lt;/b&gt;</p>"
    );
  });

  it("uses og:description, not the elided twitter:description", () => {
    const result = renderThreadsPost(page({ description: "The full post body." }), POST_URL);
    expect(result!.html).toBe("<p>The full post body.</p>");
  });

  it("does not report a publish date (Threads serves none)", () => {
    expect(renderThreadsPost(page(), POST_URL)!.publishedAt).toBeUndefined();
  });

  it("elides a long first line into the title", () => {
    const result = renderThreadsPost(page({ description: "a".repeat(150) }), POST_URL);
    expect(result!.title).toBe(`${"a".repeat(99)}…`);
  });

  it("finds Open Graph tags that appear after </head>", () => {
    const result = renderThreadsPost(
      '<html><head><title>t</title></head><meta property="og:description" content="Body.">' +
        "<body></body></html>",
      POST_URL
    );
    expect(result!.html).toBe("<p>Body.</p>");
  });

  // og:image is ALWAYS present — it's the author's avatar on a text post — so
  // rendering it unconditionally would caption every text post with a profile
  // picture. twitter:card is what distinguishes media from avatar.
  it("renders the image only when twitter:card says the image is the content", () => {
    const withMedia = renderThreadsPost(
      page({ image: MEDIA_IMAGE, card: "summary_large_image" }),
      POST_URL
    );
    expect(withMedia!.html).toContain(
      `<figure><img src="${MEDIA_IMAGE}" alt="" loading="lazy"></figure>`
    );

    // `summary` means the og:image is the avatar — never render it.
    const textOnly = renderThreadsPost(page({ card: "summary" }), POST_URL);
    expect(textOnly!.html).not.toContain("<figure>");
    expect(textOnly!.html).not.toContain("avatar.jpg");
  });

  it.each([
    ["the card is missing", { image: MEDIA_IMAGE, card: null }],
    ["the image is missing", { image: null, card: "summary_large_image" }],
    ["the image is not http(s)", { image: "javascript:alert(1)", card: "summary_large_image" }],
  ])("renders no image when %s", (_label, options) => {
    const result = renderThreadsPost(page(options), POST_URL);
    expect(result!.html).not.toContain("<figure>");
    expect(result!.html).not.toContain("javascript:");
  });

  it("keeps the post text ahead of the image, and out of the excerpt", () => {
    const result = renderThreadsPost(
      page({ description: "The comic caption.", image: MEDIA_IMAGE, card: "summary_large_image" }),
      POST_URL
    );
    expect(result!.html.indexOf("The comic caption.")).toBeLessThan(
      result!.html.indexOf("<figure>")
    );
    expect(result!.excerpt).toBe("The comic caption.");
  });

  it("returns null when the page carries no post text, so the save falls back", () => {
    expect(renderThreadsPost(page({ description: null }), POST_URL)).toBeNull();
    expect(renderThreadsPost("<html><head></head><body></body></html>", POST_URL)).toBeNull();
  });
});
