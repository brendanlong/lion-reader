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
    // The real headline is 76 characters, so it elides (see social-post.test.ts).
    expect(result!.title).toBe("Opened up your Barnes & Noble NOOK just to find it's…");
    expect(result!.author).toBe("Dave Taylor");
    expect(result!.publishedAt).toEqual(new Date("2025-04-21T17:30:02.218Z"));
    expect(result!.canonicalUrl).toBe(POST_URL);
  });

  it("prefers the headline over the body's first line for the title", () => {
    // Distinct values, so this pins which one was used in both directions.
    const distinct = { ...TEXT_POST, headline: "The headline", articleBody: "The body." };
    expect(renderLinkedInPost(page(distinct), POST_URL)!.title).toBe("The headline");
    expect(renderLinkedInPost(page({ ...distinct, headline: undefined }), POST_URL)!.title).toBe(
      "The body."
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
    expect(result!.title).toMatch(/^x+…$/);
    expect(result!.title!.length).toBeLessThan(200);
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

  // A post that shares a video carries BOTH a SocialMediaPosting (the member's
  // own commentary) and a VideoObject (the shared media). Document order does
  // not reliably put the post first, so positional first-match would sometimes
  // save the shared video's description instead of what the member wrote.
  it("prefers the post's own entity over a shared VideoObject, in either order", () => {
    const sharedVideo = {
      "@type": "VideoObject",
      description: "A SHARED VIDEO",
      thumbnailUrl: "https://media.licdn.com/poster.jpg",
    };
    const commentary = { "@type": "SocialMediaPosting", articleBody: "THE REAL POST" };

    for (const entities of [
      [sharedVideo, commentary],
      [commentary, sharedVideo],
    ]) {
      expect(renderLinkedInPost(page(entities), POST_URL)!.html).toBe("<p>THE REAL POST</p>");
    }

    // Also across a @graph, which flattens after the top-level entities.
    const graphed = [{ "@graph": [commentary] }, sharedVideo];
    expect(renderLinkedInPost(page(graphed), POST_URL)!.html).toBe("<p>THE REAL POST</p>");
  });

  it("renders a video transcript in a collapsed details block", () => {
    const result = renderLinkedInPost(
      page({
        "@type": "VideoObject",
        description: "Watch this.",
        thumbnailUrl: "https://media.licdn.com/poster.jpg",
        transcript: "Here's the formula.\n\nFirst you grab attention.",
      }),
      POST_URL
    );

    // No `open` attribute: collapsed by default.
    expect(result!.html).toContain(
      "<details><summary>Video transcript</summary>" +
        "<p>Here&#039;s the formula.</p><p>First you grab attention.</p></details>"
    );
    // The transcript must not displace the post's own text or its summary.
    expect(result!.html).toContain("<p>Watch this.</p>");
    expect(result!.excerpt).toBe("Watch this.");
  });

  it("omits the transcript block entirely when there is no transcript", () => {
    const result = renderLinkedInPost(page(TEXT_POST), POST_URL);
    expect(result!.html).not.toContain("<details>");
  });

  it("reads a DiscussionForumPosting's articleBody", () => {
    const result = renderLinkedInPost(
      page({ "@type": "DiscussionForumPosting", articleBody: "A discussion post." }),
      POST_URL
    );
    expect(result!.html).toBe("<p>A discussion post.</p>");
  });

  // JSON-LD is remote JSON: every field may be absent, the wrong type, or
  // array-wrapped. The plugin's contract is to decline, never to throw — a
  // throw on the decline path defeats the point of declining.
  describe("hostile or malformed JSON-LD", () => {
    it.each([
      // `@type` values that resolve on Object.prototype rather than the map.
      ["@type is constructor", { "@type": "constructor", articleBody: "x" }],
      ["@type is __proto__", { "@type": "__proto__", articleBody: "x" }],
      ["@type is toString", { "@type": "toString", articleBody: "x" }],
      ["@type is hasOwnProperty", { "@type": "hasOwnProperty", articleBody: "x" }],
      // Wrong types where a string is declared.
      ["@type is a number", { "@type": 42, articleBody: "x" }],
      ["articleBody is a number", { "@type": "SocialMediaPosting", articleBody: 123 }],
      ["articleBody is an object", { "@type": "SocialMediaPosting", articleBody: {} }],
      ["articleBody is null", { "@type": "SocialMediaPosting", articleBody: null }],
      ["articleBody is whitespace", { "@type": "SocialMediaPosting", articleBody: "   " }],
    ])("returns null for %s", (_label, entity) => {
      expect(renderLinkedInPost(page(entity), POST_URL)).toBeNull();
    });

    it.each([
      ["headline", { headline: 42 }],
      ["author", { author: { name: 42 } }],
      ["author as an object with no name", { author: {} }],
      ["image", { image: { url: ["https://media.licdn.com/a.jpg"] } }],
      ["thumbnailUrl", { thumbnailUrl: ["https://media.licdn.com/a.jpg"] }],
      ["datePublished", { datePublished: 123456789 }],
      ["transcript", { transcript: 42 }],
      ["everything at once", { headline: [], author: 0, image: false, datePublished: {} }],
    ])("still renders the body when %s has the wrong type", (_label, overrides) => {
      const result = renderLinkedInPost(page({ ...TEXT_POST, ...overrides }), POST_URL);
      expect(result).not.toBeNull();
      expect(result!.html).toContain("Barnes &amp; Noble NOOK");
    });

    it("does not turn a non-string datePublished into a bogus 1970 date", () => {
      const result = renderLinkedInPost(page({ ...TEXT_POST, datePublished: 123456789 }), POST_URL);
      expect(result!.publishedAt).toBeNull();
    });

    it("does not let an array-wrapped URL past the http(s) scheme gate", () => {
      const result = renderLinkedInPost(
        page({ ...TEXT_POST, image: { url: ["https://ok.jpg", "javascript:alert(1)"] } }),
        POST_URL
      );
      expect(result!.html).not.toContain("javascript:");
      expect(result!.html).not.toContain("<figure>");
    });

    it("accepts an array-wrapped @type", () => {
      const result = renderLinkedInPost(
        page({ ...TEXT_POST, "@type": ["SocialMediaPosting", "Article"] }),
        POST_URL
      );
      expect(result!.author).toBe("Dave Taylor");
    });

    it("accepts a bare author name string", () => {
      for (const author of ["Dave Taylor", ["Dave Taylor"]]) {
        expect(renderLinkedInPost(page({ ...TEXT_POST, author }), POST_URL)!.author).toBe(
          "Dave Taylor"
        );
      }
    });
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
