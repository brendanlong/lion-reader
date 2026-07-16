import { describe, it, expect } from "vitest";
import { sanitizeEntryHtml } from "@/server/html/sanitize";

describe("sanitizeEntryHtml", () => {
  describe("nullable passthrough", () => {
    it("returns null for null/undefined/empty", () => {
      expect(sanitizeEntryHtml(null)).toBeNull();
      expect(sanitizeEntryHtml(undefined)).toBeNull();
      expect(sanitizeEntryHtml("")).toBeNull();
    });
  });

  describe("XSS removal", () => {
    it("strips event-handler attributes", () => {
      expect(sanitizeEntryHtml("<img src=x onerror=alert(1)>")).not.toContain("onerror");
    });

    it("removes <script> tags and their contents", () => {
      const out = sanitizeEntryHtml("<p>hi</p><script>alert(1)</script>");
      expect(out).toBe("<p>hi</p>");
    });

    it("removes <style> tags", () => {
      const out = sanitizeEntryHtml("<style>body{display:none}</style><p>x</p>");
      expect(out).toBe("<p>x</p>");
    });

    it("strips javascript: URLs from links", () => {
      const out = sanitizeEntryHtml('<a href="javascript:alert(1)">click</a>');
      expect(out).not.toContain("javascript:");
    });

    it("drops inline event handlers on block elements", () => {
      const out = sanitizeEntryHtml('<div onclick="evil()">x</div>');
      expect(out).toBe("<div>x</div>");
    });

    it("removes script nested in svg", () => {
      const out = sanitizeEntryHtml("<svg><script>alert(1)</script></svg>");
      expect(out).not.toContain("script");
    });

    it("drops markup hidden inside rawtext/RCDATA elements (mXSS)", () => {
      // Inside title/xmp/noembed/noframes/noscript/plaintext the tokenizer
      // reads the contents as text, so an unwrap would re-emit them verbatim
      // and the browser would re-parse them as a live <img onerror>. The whole
      // subtree must be dropped instead.
      for (const tag of ["title", "xmp", "noembed", "noframes", "noscript", "plaintext"]) {
        const out =
          sanitizeEntryHtml(`<p>ok</p><${tag}><img src=x onerror=alert(1)></${tag}>`) ?? "";
        expect(out).not.toContain("onerror");
        expect(out).not.toContain("<img");
        expect(out).toContain("<p>ok</p>");
      }
    });
  });

  describe("link and image transforms (formerly the DOMPurify hook)", () => {
    it("opens external links in a new tab with safe rel", () => {
      const out = sanitizeEntryHtml('<a href="https://example.com">x</a>') ?? "";
      expect(out).toContain('target="_blank"');
      expect(out).toContain('rel="noopener noreferrer"');
    });

    it("treats protocol-relative links as external (anti reverse-tabnabbing)", () => {
      const out = sanitizeEntryHtml('<a href="//example.com">x</a>') ?? "";
      expect(out).toContain('target="_blank"');
      expect(out).toContain('rel="noopener noreferrer"');
    });

    it("detects external links case-insensitively", () => {
      const out = sanitizeEntryHtml('<a href="HTTPS://EXAMPLE.COM">x</a>') ?? "";
      expect(out).toContain('target="_blank"');
      expect(out).toContain('rel="noopener noreferrer"');
    });

    it("detects external links despite leading whitespace", () => {
      const out = sanitizeEntryHtml('<a href=" https://example.com">x</a>') ?? "";
      expect(out).toContain('rel="noopener noreferrer"');
    });

    it("leaves relative links untouched", () => {
      const out = sanitizeEntryHtml('<a href="/foo">x</a>') ?? "";
      expect(out).not.toContain("target");
      expect(out).toContain('href="/foo"');
    });

    it("adds loading=lazy to images", () => {
      const out = sanitizeEntryHtml('<img src="https://example.com/a.png">') ?? "";
      expect(out).toContain('loading="lazy"');
    });
  });

  describe("MathML (browser-native equations)", () => {
    it("preserves presentation MathML", () => {
      const html =
        '<math display="block"><mrow><mfrac><mi>a</mi><mn>2</mn></mfrac>' +
        "<mo>+</mo><msup><mi>x</mi><mn>2</mn></msup></mrow></math>";
      const out = sanitizeEntryHtml(html) ?? "";
      expect(out).toContain("<math");
      expect(out).toContain("<mfrac>");
      expect(out).toContain("<msup>");
      expect(out).toContain('display="block"');
    });

    it("strips href/javascript: and event handlers on MathML elements", () => {
      const out =
        sanitizeEntryHtml('<math><mi href="javascript:alert(1)" onclick="x()">y</mi></math>') ?? "";
      expect(out).not.toContain("javascript");
      expect(out).not.toContain("onclick");
      expect(out).toContain("<mi>y</mi>");
    });

    it("blocks the annotation-xml mutation-XSS vector", () => {
      const out =
        sanitizeEntryHtml(
          '<math><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></math>'
        ) ?? "";
      expect(out).not.toContain("annotation-xml");
      expect(out).not.toContain("onerror");
    });
  });

  describe("inline SVG (issue #923)", () => {
    it("keeps a safe inline SVG with camelCase attributes intact", () => {
      const out =
        sanitizeEntryHtml(
          '<p>x</p><svg viewBox="0 0 10 10"><linearGradient id="g">' +
            '<stop offset="0" stop-color="red"/></linearGradient>' +
            '<circle cx="5" cy="5" r="5" preserveAspectRatio="none" fill="url(#g)"/></svg>'
        ) ?? "";
      expect(out).toContain("<p>x</p>");
      expect(out).toContain("<svg");
      // camelCase must survive verbatim (case-folding would break rendering).
      expect(out).toContain("viewBox=");
      expect(out).toContain("<linearGradient");
      expect(out).toContain("preserveAspectRatio=");
      expect(out).not.toContain("viewbox=");
    });

    it("does not disturb surrounding uppercase HTML", () => {
      const out =
        sanitizeEntryHtml('<DIV CLASS="wrap"><svg><rect width="4" height="4"/></svg></DIV>') ?? "";
      // Uppercase HTML is matched case-insensitively; lol_html passes the
      // original bytes through untouched (HTML tag/attribute names are
      // case-insensitive, so this renders identically).
      expect(out).toContain('<DIV CLASS="wrap">');
      expect(out).toContain("<rect");
    });

    it("removes <script> inside svg", () => {
      const out = sanitizeEntryHtml('<svg><script>alert(1)</script><circle r="5"/></svg>') ?? "";
      expect(out).not.toContain("script");
      expect(out).toContain("<circle");
    });

    it("strips on* event handlers on svg elements", () => {
      const out =
        sanitizeEntryHtml(
          '<svg onload="alert(1)"><rect onclick="evil()" width="1" height="1"/></svg>'
        ) ?? "";
      expect(out).not.toContain("onload");
      expect(out).not.toContain("onclick");
      expect(out).not.toContain("alert");
    });

    it("removes <foreignObject> and its arbitrary HTML", () => {
      const out =
        sanitizeEntryHtml(
          "<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>"
        ) ?? "";
      expect(out.toLowerCase()).not.toContain("foreignobject");
      expect(out).not.toContain("onerror");
      expect(out).not.toContain("<img");
    });

    it("drops <use> entirely (external-reference risk)", () => {
      const out =
        sanitizeEntryHtml('<svg><use href="javascript:alert(1)"/><use xlink:href="#ok"/></svg>') ??
        "";
      expect(out).not.toContain("use");
      expect(out).not.toContain("javascript");
    });

    it("drops animation elements (no attributeName=href vector)", () => {
      const out =
        sanitizeEntryHtml(
          '<svg><a><animate attributeName="href" values="javascript:alert(1)"/></a></svg>'
        ) ?? "";
      expect(out).not.toContain("animate");
      expect(out).not.toContain("javascript");
    });

    it("strips javascript: hrefs on svg <a> but keeps safe links", () => {
      const out =
        sanitizeEntryHtml(
          '<svg><a href="javascript:alert(1)"><text>a</text></a>' +
            '<a xlink:href="https://ok.com"><text>b</text></a></svg>'
        ) ?? "";
      expect(out).not.toContain("javascript");
      expect(out).toContain('xlink:href="https://ok.com"');
    });

    it("forces safe rel/target on external svg <a> links (anti reverse-tabnabbing)", () => {
      const out = sanitizeEntryHtml('<svg><a href="https://ok.com"><text>x</text></a></svg>') ?? "";
      expect(out).toContain('target="_blank"');
      expect(out).toContain('rel="noopener noreferrer"');
      // In-document fragment links are not external and stay untouched.
      const frag = sanitizeEntryHtml('<svg><a href="#sec"><text>y</text></a></svg>') ?? "";
      expect(frag).not.toContain("target=");
    });

    it("decodes entity-obfuscated javascript: hrefs before checking", () => {
      const out =
        sanitizeEntryHtml('<svg><a href="jav&#x09;ascript:alert(1)"><text>x</text></a></svg>') ??
        "";
      expect(out).not.toContain("javascript");
    });

    it("allows http/data image refs but blocks javascript:", () => {
      const out =
        sanitizeEntryHtml(
          '<svg><image href="https://ex.com/a.png"/><image href="data:image/png;base64,iVBOR"/>' +
            '<image href="javascript:alert(1)"/></svg>'
        ) ?? "";
      expect(out).toContain('href="https://ex.com/a.png"');
      expect(out).toContain("data:image/png;base64");
      expect(out).not.toContain("javascript");
    });

    it("allows only same-document #fragment refs on template elements", () => {
      const out =
        sanitizeEntryHtml(
          '<svg><linearGradient href="https://evil.com/x"/><radialGradient href="#tmpl"/></svg>'
        ) ?? "";
      expect(out).not.toContain("evil.com");
      expect(out).toContain('href="#tmpl"');
    });

    it("drops style attributes (CSS policy, matching HTML)", () => {
      const out = sanitizeEntryHtml('<svg><circle r="5" style="fill:red"/></svg>') ?? "";
      expect(out).not.toContain("style");
    });

    it("handles multiple SVGs and an unclosed SVG", () => {
      const two =
        sanitizeEntryHtml(
          '<svg><circle r="1"/></svg><p>mid</p><svg><rect width="2" height="2"/></svg>'
        ) ?? "";
      expect(two).toContain("<circle");
      expect(two).toContain("<p>mid</p>");
      expect(two).toContain("<rect");

      const unclosed = sanitizeEntryHtml('<p>a</p><svg><circle r="1">') ?? "";
      expect(unclosed).toContain("<p>a</p>");
      expect(unclosed).toContain("<circle");
    });
  });

  describe("additional XSS hardening (sanitize-html internals)", () => {
    it("drops inline style attributes (CSS-based vectors)", () => {
      const out = sanitizeEntryHtml('<p style="position:fixed;inset:0">x</p>') ?? "";
      expect(out).not.toContain("style");
      expect(out).toBe("<p>x</p>");
    });

    it("strips javascript: regardless of case/whitespace", () => {
      expect(sanitizeEntryHtml('<a href="\\tJAVASCRIPT:alert(1)">x</a>')).not.toContain(
        "javascript"
      );
    });

    it("strips dangerous srcset entries on images", () => {
      const out = sanitizeEntryHtml('<img srcset="javascript:alert(1) 1x">') ?? "";
      expect(out).not.toContain("javascript");
    });
  });

  describe("legitimate content is preserved", () => {
    it("keeps headings, lists, blockquotes, code, and tables", () => {
      const html =
        "<h2>Title</h2><ul><li>a</li></ul><blockquote>q</blockquote>" +
        '<pre><code>x = 1</code></pre><table><tr><td colspan="2">c</td></tr></table>';
      const out = sanitizeEntryHtml(html) ?? "";
      expect(out).toContain("<h2>");
      expect(out).toContain("<li>");
      expect(out).toContain("<blockquote>");
      expect(out).toContain("<code>");
      expect(out).toContain('colspan="2"');
    });

    it("strips iframes from non-allow-listed hosts (phishing/tracking surface)", () => {
      const out =
        sanitizeEntryHtml(
          '<iframe src="https://evil.example/fake-login" allowfullscreen></iframe>'
        ) ?? "";
      expect(out).not.toContain("<iframe");
      expect(out).not.toContain("evil.example");
    });

    it("keeps data: image URIs", () => {
      const out = sanitizeEntryHtml('<img src="data:image/png;base64,iVBOR">') ?? "";
      expect(out).toContain("data:image/png;base64");
    });

    it("preserves the narration data-para-id attribute", () => {
      const out = sanitizeEntryHtml('<p data-para-id="3">x</p>') ?? "";
      expect(out).toContain('data-para-id="3"');
    });
  });

  describe("YouTube embed iframes (issue #1115)", () => {
    it("keeps a YouTube embed, rewritten to youtube-nocookie with forced sandbox", () => {
      const out =
        sanitizeEntryHtml(
          '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" width="560" height="315"></iframe>'
        ) ?? "";
      expect(out).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"');
      expect(out).toContain('sandbox="allow-scripts allow-same-origin');
      expect(out).toContain('loading="lazy"');
      expect(out).toContain('width="560"');
      expect(out).toContain('height="315"');
    });

    it("normalizes protocol-relative embed srcs", () => {
      const out =
        sanitizeEntryHtml('<iframe src="//www.youtube.com/embed/abc123def45"></iframe>') ?? "";
      expect(out).toContain('src="https://www.youtube-nocookie.com/embed/abc123def45"');
    });

    it("keeps playback params but drops autoplay and JS-API params", () => {
      const out =
        sanitizeEntryHtml(
          '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?start=30&autoplay=1&enablejsapi=1"></iframe>'
        ) ?? "";
      expect(out).toContain("start=30");
      expect(out).not.toContain("autoplay");
      expect(out).not.toContain("enablejsapi");
    });

    it("keeps playlist embeds", () => {
      const out =
        sanitizeEntryHtml(
          '<iframe src="https://www.youtube.com/embed/videoseries?list=PL0123abc"></iframe>'
        ) ?? "";
      expect(out).toContain(
        'src="https://www.youtube-nocookie.com/embed/videoseries?list=PL0123abc"'
      );
    });

    it("overrides a feed-supplied sandbox/allow with the forced values", () => {
      const out =
        sanitizeEntryHtml(
          '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" sandbox="allow-top-navigation" allow="autoplay"></iframe>'
        ) ?? "";
      expect(out).not.toContain("allow-top-navigation");
      expect(out).not.toContain('allow="autoplay"');
    });

    it("removes YouTube iframes that are not embed URLs", () => {
      const out =
        sanitizeEntryHtml(
          '<iframe src="https://www.youtube.com/watch?v=dQw4w9WgXcQ"></iframe><p>x</p>'
        ) ?? "";
      expect(out).toBe("<p>x</p>");
    });

    it("removes iframes with dangerous or missing srcs entirely", () => {
      expect(sanitizeEntryHtml('<iframe src="javascript:alert(1)"></iframe>')).toBe("");
      expect(sanitizeEntryHtml("<iframe></iframe>")).toBe("");
      expect(
        sanitizeEntryHtml('<iframe src="https://www.youtube.com.evil.com/embed/x"></iframe>')
      ).toBe("");
    });
  });

  describe("other allow-listed embed providers (issue #922)", () => {
    it("keeps a Vimeo embed with a forced sandbox", () => {
      const out =
        sanitizeEntryHtml(
          '<iframe src="https://player.vimeo.com/video/76979871?h=abc" width="640" height="360"></iframe>'
        ) ?? "";
      expect(out).toContain('src="https://player.vimeo.com/video/76979871?h=abc"');
      expect(out).toContain('sandbox="allow-scripts');
      expect(out).toContain('loading="lazy"');
      expect(out).toContain('width="640"');
    });

    it("keeps a Spotify embed", () => {
      const out =
        sanitizeEntryHtml(
          '<iframe src="https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT"></iframe>'
        ) ?? "";
      expect(out).toContain('src="https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT"');
    });

    it("keeps a SoundCloud player pointing at SoundCloud", () => {
      const out =
        sanitizeEntryHtml(
          '<iframe src="https://w.soundcloud.com/player/?url=https%3A%2F%2Fapi.soundcloud.com%2Ftracks%2F123"></iframe>'
        ) ?? "";
      expect(out).toContain("w.soundcloud.com/player/");
      expect(out).toContain("api.soundcloud.com");
    });

    it("keeps a Bandcamp EmbeddedPlayer", () => {
      const out =
        sanitizeEntryHtml(
          '<iframe src="https://bandcamp.com/EmbeddedPlayer/album=123/size=large/"></iframe>'
        ) ?? "";
      expect(out).toContain("bandcamp.com/EmbeddedPlayer/album=123/size=large/");
    });

    it("keeps a CodePen embed", () => {
      const out =
        sanitizeEntryHtml('<iframe src="https://codepen.io/team/embed/abcDEF"></iframe>') ?? "";
      expect(out).toContain('src="https://codepen.io/team/embed/abcDEF"');
    });
  });
});
