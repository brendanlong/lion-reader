/**
 * Unit tests for the LinkedIn plugin. LinkedIn has no public read API, but a
 * public post page served to a logged-out client carries a JSON-LD
 * `SocialMediaPosting` (or `VideoObject`) with the full post body, author, and
 * publish date — that's what the plugin renders.
 *
 * These cover the pure functions (URL parsing, page rendering) against captured
 * page shapes — no network.
 */

import { describe, it, expect } from "vitest";
import {
  linkedInPlugin,
  parseLinkedInPostUrn,
  renderLinkedInPost,
} from "@/server/plugins/linkedin";

const POST_URL =
  "https://www.linkedin.com/posts/davetaylor_fix-a-bn-nook-android-tablet-with-the-wrong-activity-7320136747835609090-dqeB";

/** Wrap JSON-LD (and optional extra head markup) in a minimal post page. */
function page(jsonLd: unknown, extraHead = ""): string {
  return [
    "<html><head>",
    jsonLd === null ? "" : `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`,
    extraHead,
    "</head><body><div>sign in to see more</div></body></html>",
  ].join("");
}

/** A text post, shaped like the real thing (fields we don't read omitted). */
const TEXT_POST = {
  "@context": "http://schema.org",
  "@type": "SocialMediaPosting",
  "@id": POST_URL,
  datePublished: "2025-04-21T17:30:02.218Z",
  headline: "Opened up your Barnes & Noble NOOK just to find it's showing the wrong time?",
  text: "Fix a B&N Nook Android Tablet with the Wrong Time",
  articleBody:
    "Opened up your Barnes & Noble NOOK just to find it's showing the wrong time?\n\nhttps://lnkd.in/gyivVrsj #nook #android",
  image: {
    url: "https://media.licdn.com/dms/image/sync/v2/post-image.jpg",
    "@type": "ImageObject",
  },
  author: {
    name: "Dave Taylor",
    url: "https://www.linkedin.com/in/davetaylor",
    "@type": "Person",
  },
};

describe("parseLinkedInPostUrn", () => {
  it("parses the /posts/ share URL form", () => {
    expect(parseLinkedInPostUrn(new URL(POST_URL))).toBe("urn:li:activity:7320136747835609090");
  });

  it("ignores tracking query params", () => {
    expect(parseLinkedInPostUrn(new URL(`${POST_URL}?utm_source=share&rcm=ACoAAAA`))).toBe(
      "urn:li:activity:7320136747835609090"
    );
  });

  it("parses the /feed/update/ permalink form, including share and ugcPost URNs", () => {
    expect(
      parseLinkedInPostUrn(new URL("https://www.linkedin.com/feed/update/urn:li:activity:123"))
    ).toBe("urn:li:activity:123");
    expect(
      parseLinkedInPostUrn(new URL("https://www.linkedin.com/feed/update/urn:li:share:456"))
    ).toBe("urn:li:share:456");
    expect(
      parseLinkedInPostUrn(new URL("https://www.linkedin.com/feed/update/urn:li:ugcPost:789"))
    ).toBe("urn:li:ugcPost:789");
  });

  it("parses a percent-encoded permalink", () => {
    expect(
      parseLinkedInPostUrn(
        new URL("https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A123")
      )
    ).toBe("urn:li:activity:123");
  });

  it("returns null for profiles, company pages, jobs, and /pulse/ articles", () => {
    for (const path of [
      "/in/davetaylor",
      "/company/linkedin",
      "/jobs/view/123",
      "/pulse/some-long-form-article-author",
      "/posts/davetaylor_no-activity-id-here",
      "/feed/",
    ]) {
      expect(parseLinkedInPostUrn(new URL(`https://www.linkedin.com${path}`))).toBeNull();
    }
  });

  it("returns null for non-LinkedIn hosts", () => {
    expect(parseLinkedInPostUrn(new URL("https://example.com/posts/x-activity-123-ab"))).toBeNull();
  });

  it("drives matchUrl (posts only)", () => {
    expect(linkedInPlugin.matchUrl(new URL(POST_URL))).toBe(true);
    expect(linkedInPlugin.matchUrl(new URL("https://www.linkedin.com/in/davetaylor"))).toBe(false);
  });

  // `new URL()` and the save path's `z.string().url()` both accept a malformed
  // percent-escape, and the registry calls matchUrl OUTSIDE the try that wraps
  // fetchContent — so a throw here is a 500 on save, not a fallback.
  it("does not throw on a malformed percent-escape", () => {
    for (const path of ["/%", "/feed/update/%E0%A4%A", "/posts/%ZZ-activity-123-ab"]) {
      expect(() =>
        linkedInPlugin.matchUrl(new URL(`https://www.linkedin.com${path}`))
      ).not.toThrow();
    }
  });
});

describe("renderLinkedInPost", () => {
  it("renders a text post's body, title, author, date, and image", () => {
    const result = renderLinkedInPost(page(TEXT_POST), POST_URL);

    expect(result).not.toBeNull();
    expect(result!.html).toBe(
      "<p>Opened up your Barnes &amp; Noble NOOK just to find it&#039;s showing the wrong time?</p>" +
        '<p><a href="https://lnkd.in/gyivVrsj">https://lnkd.in/gyivVrsj</a> #nook #android</p>\n' +
        '<figure><img src="https://media.licdn.com/dms/image/sync/v2/post-image.jpg" alt="" loading="lazy"></figure>'
    );
    expect(result!.title).toBe(
      "Opened up your Barnes & Noble NOOK just to find it's showing the wrong time?"
    );
    expect(result!.author).toBe("Dave Taylor");
    expect(result!.publishedAt).toEqual(new Date("2025-04-21T17:30:02.218Z"));
    expect(result!.canonicalUrl).toBe(POST_URL);
  });

  it("prefers articleBody over the `text` field, which is the shared link's title", () => {
    const result = renderLinkedInPost(page(TEXT_POST), POST_URL);
    expect(result!.html).not.toContain("Fix a B&amp;N Nook Android Tablet");
  });

  it("derives a title from the first line when there is no headline", () => {
    const result = renderLinkedInPost(page({ ...TEXT_POST, headline: undefined }), POST_URL);
    expect(result!.title).toBe(
      "Opened up your Barnes & Noble NOOK just to find it's showing the wrong time?"
    );
  });

  it("renders a video post from its description, linking the poster frame to the post", () => {
    const result = renderLinkedInPost(
      page({
        "@type": "VideoObject",
        headline: "Want to get more attention on LinkedIn?",
        description: "Want to get more attention on LinkedIn?\n\nWrite posts with this formula:",
        datePublished: "2025-08-20T13:32:45.853Z",
        thumbnailUrl: "https://media.licdn.com/dms/image/poster.jpg",
        creator: { name: "Jason Feifer" },
      }),
      POST_URL
    );

    expect(result!.author).toBe("Jason Feifer");
    expect(result!.html).toContain("<p>Write posts with this formula:</p>");
    expect(result!.html).toContain(`<figure><a href="${POST_URL}">`);
    expect(result!.html).toContain('<img src="https://media.licdn.com/dms/image/poster.jpg"');
    expect(result!.html).toContain("Watch video on LinkedIn");
  });

  // og:description is the *shared article's* description on a link-share post,
  // and LinkedIn serves one on non-post pages too, so saving it as the body
  // risks storing something that isn't the post. Falling back to Readability is
  // a better outcome than a confident wrong answer.
  it("returns null rather than saving og:description as the body", () => {
    const result = renderLinkedInPost(
      page(
        null,
        '<meta property="og:description" content="The whole post body. | 21 comments on LinkedIn">'
      ),
      POST_URL
    );
    expect(result).toBeNull();
  });

  it("skips JSON-LD blocks that carry no body", () => {
    const html = [
      "<html><head>",
      '<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>',
      `<script type="application/ld+json">${JSON.stringify(TEXT_POST)}</script>`,
      "</head><body></body></html>",
    ].join("");
    expect(renderLinkedInPost(html, POST_URL)!.author).toBe("Dave Taylor");
  });

  it("unwraps a @graph container", () => {
    const result = renderLinkedInPost(
      page({ "@context": "https://schema.org", "@graph": [TEXT_POST] }),
      POST_URL
    );
    expect(result!.author).toBe("Dave Taylor");
    expect(result!.html).toContain("Barnes &amp; Noble NOOK");
  });

  it("elides an over-long headline instead of storing it raw", () => {
    const result = renderLinkedInPost(page({ ...TEXT_POST, headline: "x".repeat(5000) }), POST_URL);
    expect(result!.title).toBe(`${"x".repeat(99)}…`);
  });

  it("accepts schema.org's single-or-array and bare-string shapes", () => {
    const result = renderLinkedInPost(
      page({
        ...TEXT_POST,
        author: [{ name: "Dave Taylor" }],
        image: "https://media.licdn.com/bare-string.jpg",
      }),
      POST_URL
    );
    expect(result!.author).toBe("Dave Taylor");
    expect(result!.html).toContain('src="https://media.licdn.com/bare-string.jpg"');
  });

  it("skips past an unusable image URL to a valid one", () => {
    const result = renderLinkedInPost(
      page({
        ...TEXT_POST,
        image: [{ url: "javascript:alert(1)" }, { url: "https://media.licdn.com/ok.jpg" }],
      }),
      POST_URL
    );
    expect(result!.html).toContain('src="https://media.licdn.com/ok.jpg"');
  });

  it("survives malformed JSON-LD without throwing", () => {
    const html = [
      "<html><head>",
      '<script type="application/ld+json">{not json</script>',
      `<script type="application/ld+json">${JSON.stringify(TEXT_POST)}</script>`,
      "</head><body></body></html>",
    ].join("");
    expect(renderLinkedInPost(html, POST_URL)!.author).toBe("Dave Taylor");
  });

  // The whole point of gating on @type: an Organization's boilerplate
  // description must never be mistaken for the post, in any position.
  it("ignores an entity whose @type is not a post, whatever fields it carries", () => {
    const org = {
      "@type": "Organization",
      name: "LinkedIn",
      description: "LinkedIn is the world's largest professional network.",
      articleBody: "Not a post either.",
    };
    expect(renderLinkedInPost(page(org), POST_URL)).toBeNull();
    expect(renderLinkedInPost(page([org, TEXT_POST]), POST_URL)!.author).toBe("Dave Taylor");
  });

  it("does not read `description` on a text post, which describes the shared link", () => {
    const result = renderLinkedInPost(
      page({ ...TEXT_POST, articleBody: undefined, description: "The shared article's summary." }),
      POST_URL
    );
    expect(result).toBeNull();
  });

  it("returns null for an auth wall with no post body, so the save falls back", () => {
    expect(
      renderLinkedInPost(
        "<html><head><title>Sign Up | LinkedIn</title></head><body>Join now</body></html>",
        POST_URL
      )
    ).toBeNull();
  });

  it("returns null rather than a date when datePublished is unparseable", () => {
    const result = renderLinkedInPost(
      page({ ...TEXT_POST, datePublished: "not a date" }),
      POST_URL
    );
    expect(result!.publishedAt).toBeNull();
  });

  it("ignores a non-http image URL", () => {
    const result = renderLinkedInPost(
      page({ ...TEXT_POST, image: { url: "javascript:alert(1)" } }),
      POST_URL
    );
    expect(result!.html).not.toContain("<figure>");
  });
});
