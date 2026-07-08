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

  describe("SVG is dropped (not safely supportable via sanitize-html)", () => {
    it("removes svg and its contents", () => {
      const out = sanitizeEntryHtml('<p>x</p><svg><circle r="5"/></svg>') ?? "";
      expect(out).toBe("<p>x</p>");
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

    it("strips iframes (phishing/tracking surface; not on DOMPurify's default list)", () => {
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
});
