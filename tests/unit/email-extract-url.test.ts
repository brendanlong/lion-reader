/**
 * Unit tests for extracting canonical URLs from newsletter email HTML.
 */

import { describe, it, expect } from "vitest";
import { extractEmailUrl } from "@/server/email/extract-url";

describe("extractEmailUrl", () => {
  describe("Substack emails", () => {
    it("extracts URL from Substack post title h1", () => {
      const html = `
        <h1 class="post-title published">
          <a href="https://open.substack.com/pub/astralcodexten/p/political-backflow-from-europe?utm_source=post-email-title&utm_campaign=email-post-title&isFreemail=false&r=67xro&token=abc123">
            Political Backflow From Europe
          </a>
        </h1>
      `;
      expect(extractEmailUrl(html)).toBe(
        "https://open.substack.com/pub/astralcodexten/p/political-backflow-from-europe"
      );
    });

    it("strips tracking parameters from open.substack.com URLs", () => {
      const html = `
        <h1>
          <a href="https://open.substack.com/pub/test/p/my-post?utm_source=email&utm_campaign=test&r=abc">
            Test Post
          </a>
        </h1>
      `;
      expect(extractEmailUrl(html)).toBe("https://open.substack.com/pub/test/p/my-post");
    });

    it("skips substack.com/app-link URLs", () => {
      // app-link URLs are deep links, not web URLs
      const html = `
        <h1>
          <a href="https://substack.com/app-link/post?publication_id=89120&post_id=182110210&utm_source=post-email-title">
            Title
          </a>
        </h1>
      `;
      expect(extractEmailUrl(html)).toBeNull();
    });

    it("handles custom domain Substack (not *.substack.com)", () => {
      const html = `
        <h1>
          <a href="https://www.astralcodexten.com/p/political-backflow-from-europe?utm_source=email">
            Political Backflow From Europe
          </a>
        </h1>
      `;
      expect(extractEmailUrl(html)).toBe(
        "https://www.astralcodexten.com/p/political-backflow-from-europe"
      );
    });

    it("handles *.substack.com/p/ URLs with tracking params", () => {
      const html = `
        <h1>
          <a href="https://mysubstack.substack.com/p/my-post?utm_source=email&utm_medium=reader&r=abc">
            My Post
          </a>
        </h1>
      `;
      expect(extractEmailUrl(html)).toBe("https://mysubstack.substack.com/p/my-post");
    });
  });

  describe("general newsletter emails", () => {
    it("extracts URL from h1 > a", () => {
      const html = `
        <div>Some header content</div>
        <h1><a href="https://example.com/post/123">My Great Article</a></h1>
        <p>Some content...</p>
      `;
      expect(extractEmailUrl(html)).toBe("https://example.com/post/123");
    });

    it("extracts URL from h2 > a", () => {
      const html = `
        <div>Header</div>
        <h2><a href="https://blog.example.com/article">Article Title</a></h2>
        <p>Content...</p>
      `;
      expect(extractEmailUrl(html)).toBe("https://blog.example.com/article");
    });

    it("extracts URL from h3 > a", () => {
      const html = `
        <h3><a href="https://example.com/post">Post Title</a></h3>
      `;
      expect(extractEmailUrl(html)).toBe("https://example.com/post");
    });

    it("prefers h1 link (stops at first heading link)", () => {
      const html = `
        <h1><a href="https://example.com/main-post">Main Title</a></h1>
        <h2><a href="https://example.com/secondary">Secondary</a></h2>
      `;
      expect(extractEmailUrl(html)).toBe("https://example.com/main-post");
    });

    it("handles nested elements inside heading", () => {
      const html = `
        <h1>
          <strong>
            <a href="https://example.com/post">
              Bold Title
            </a>
          </strong>
        </h1>
      `;
      expect(extractEmailUrl(html)).toBe("https://example.com/post");
    });

    it("strips common tracking parameters", () => {
      const html = `
        <h1><a href="https://example.com/post?utm_source=email&utm_medium=newsletter&utm_campaign=weekly">Title</a></h1>
      `;
      expect(extractEmailUrl(html)).toBe("https://example.com/post");
    });

    it("preserves non-tracking query parameters", () => {
      const html = `
        <h1><a href="https://example.com/post?id=123&category=tech&utm_source=email">Title</a></h1>
      `;
      expect(extractEmailUrl(html)).toBe("https://example.com/post?id=123&category=tech");
    });
  });

  describe("URLs to skip", () => {
    it("skips mailto: links", () => {
      const html = `
        <h1><a href="mailto:contact@example.com">Contact Us</a></h1>
      `;
      expect(extractEmailUrl(html)).toBeNull();
    });

    it("skips unsubscribe links", () => {
      const html = `
        <h1><a href="https://example.com/unsubscribe?token=abc">Unsubscribe</a></h1>
      `;
      expect(extractEmailUrl(html)).toBeNull();
    });

    it("skips subscribe links", () => {
      const html = `
        <h1><a href="https://example.com/subscribe?ref=email">Subscribe</a></h1>
      `;
      expect(extractEmailUrl(html)).toBeNull();
    });

    it("ignores links outside heading elements", () => {
      const html = `
        <p><a href="https://example.com/not-the-title">Some link</a></p>
        <a href="https://example.com/another-link">Another link</a>
      `;
      expect(extractEmailUrl(html)).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("returns null for empty string", () => {
      expect(extractEmailUrl("")).toBeNull();
    });

    it("returns null for HTML with no headings", () => {
      const html = `
        <div>
          <p>Just some content</p>
          <a href="https://example.com">Link</a>
        </div>
      `;
      expect(extractEmailUrl(html)).toBeNull();
    });

    it("returns null for headings without links", () => {
      const html = `
        <h1>Title Without Link</h1>
        <p>Content</p>
      `;
      expect(extractEmailUrl(html)).toBeNull();
    });

    it("returns null for headings with empty href", () => {
      const html = `<h1><a href="">Title</a></h1>`;
      expect(extractEmailUrl(html)).toBeNull();
    });

    it("handles malformed HTML gracefully", () => {
      const html = `<h1><a href="https://example.com/post">Title`;
      // htmlparser2 handles malformed HTML - should still extract
      expect(extractEmailUrl(html)).toBe("https://example.com/post");
    });
  });

  describe("real-world Substack email fragment", () => {
    it("extracts URL from realistic Substack email structure", () => {
      // Simplified but representative Substack email structure
      const html = `
        <table role="presentation" width="100%">
          <tbody><tr><td></td><td class="content" width="550" align="left">
            <div class="post typography" dir="auto">
              <div class="post-header" role="region">
                <h1 class="post-title published title-X77sOw" dir="auto">
                  <a href="https://open.substack.com/pub/astralcodexten/p/political-backflow-from-europe?utm_source=post-email-title&amp;utm_campaign=email-post-title&amp;isFreemail=false&amp;r=67xro&amp;token=eyJ1c2VyX2lkIjoxMDQ0ODA1MiwicG9zdF9pZCI6MTgyMTEwMjEwfQ.test" target="_blank" rel="noopener noreferrer">
                    Political Backflow From Europe
                  </a>
                </h1>
                <h3 class="subtitle">Some subtitle text...</h3>
              </div>
            </div>
            <div class="post typography" dir="auto">
              <div class="body markup" dir="auto">
                <p>The European discourse can be...</p>
              </div>
            </div>
          </td><td></td></tr></tbody>
        </table>
      `;
      expect(extractEmailUrl(html)).toBe(
        "https://open.substack.com/pub/astralcodexten/p/political-backflow-from-europe"
      );
    });
  });
});
