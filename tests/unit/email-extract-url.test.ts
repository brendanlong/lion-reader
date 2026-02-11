/**
 * Unit tests for extracting canonical URLs and unsubscribe URLs from newsletter email HTML.
 */

import { describe, it, expect } from "vitest";
import { extractEmailUrl, extractUnsubscribeUrl } from "@/server/email/extract-url";

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

describe("extractUnsubscribeUrl", () => {
  describe("basic extraction", () => {
    it("extracts unsubscribe link from email HTML", () => {
      const html = `
        <p>You received this email because you subscribed.</p>
        <a href="https://example.com/unsubscribe?token=abc123">Unsubscribe</a>
      `;
      expect(extractUnsubscribeUrl(html)).toBe("https://example.com/unsubscribe?token=abc123");
    });

    it("extracts unsubscribe link with mixed case text", () => {
      const html = `
        <a href="https://example.com/unsubscribe">UNSUBSCRIBE</a>
      `;
      expect(extractUnsubscribeUrl(html)).toBe("https://example.com/unsubscribe");
    });

    it("extracts unsubscribe link when text says 'click here to unsubscribe'", () => {
      const html = `
        <a href="https://example.com/unsubscribe?id=123">Click here to unsubscribe</a>
      `;
      expect(extractUnsubscribeUrl(html)).toBe("https://example.com/unsubscribe?id=123");
    });

    it("returns null when no unsubscribe link found", () => {
      const html = `
        <h1><a href="https://example.com/article">My Article</a></h1>
        <p>Some content</p>
      `;
      expect(extractUnsubscribeUrl(html)).toBeNull();
    });

    it("returns null for empty HTML", () => {
      expect(extractUnsubscribeUrl("")).toBeNull();
    });

    it("returns null for null-like input", () => {
      expect(extractUnsubscribeUrl("")).toBeNull();
    });
  });

  describe("URL filtering", () => {
    it("skips tracking domain URLs even with unsubscribe text", () => {
      const html = `
        <a href="https://email.mg1.substack.com/c/something/unsubscribe">Unsubscribe</a>
        <a href="https://newsletter.example.com/unsubscribe">Unsubscribe</a>
      `;
      expect(extractUnsubscribeUrl(html)).toBe("https://newsletter.example.com/unsubscribe");
    });

    it("skips non-http URLs", () => {
      const html = `
        <a href="mailto:unsubscribe@example.com">Unsubscribe</a>
      `;
      expect(extractUnsubscribeUrl(html)).toBeNull();
    });

    it("prefers URL with unsubscribe path over URL without", () => {
      const html = `
        <a href="https://example.com/preferences">Unsubscribe from this list</a>
        <a href="https://example.com/unsubscribe?token=abc">Unsubscribe</a>
      `;
      expect(extractUnsubscribeUrl(html)).toBe("https://example.com/unsubscribe?token=abc");
    });

    it("falls back to text-only match when no path match", () => {
      const html = `
        <a href="https://example.com/manage?action=remove">Unsubscribe</a>
      `;
      expect(extractUnsubscribeUrl(html)).toBe("https://example.com/manage?action=remove");
    });
  });

  describe("real-world newsletter patterns", () => {
    it("extracts Substack unsubscribe link", () => {
      const html = `
        <table>
          <tr><td>
            <h1><a href="https://open.substack.com/pub/test/p/my-post">My Post</a></h1>
            <p>Content here...</p>
            <p>
              <a href="https://test.substack.com/action/disable_email">Unsubscribe</a>
            </p>
          </td></tr>
        </table>
      `;
      expect(extractUnsubscribeUrl(html)).toBe("https://test.substack.com/action/disable_email");
    });

    it("extracts Ghost newsletter unsubscribe link", () => {
      const html = `
        <div class="post">
          <h2><a href="https://blog.example.com/my-post/">My Post</a></h2>
          <p>Content...</p>
        </div>
        <div class="footer">
          <a href="https://blog.example.com/unsubscribe/?uuid=abc123">Unsubscribe</a>
        </div>
      `;
      expect(extractUnsubscribeUrl(html)).toBe("https://blog.example.com/unsubscribe/?uuid=abc123");
    });

    it("extracts Buttondown unsubscribe link", () => {
      const html = `
        <p>You're receiving this because you subscribed.</p>
        <a href="https://buttondown.com/author/unsubscribe/abc123">Unsubscribe</a>
      `;
      expect(extractUnsubscribeUrl(html)).toBe("https://buttondown.com/author/unsubscribe/abc123");
    });

    it("extracts unsubscribe link from complex footer", () => {
      const html = `
        <table role="presentation">
          <tr><td>
            <p style="color: #999; font-size: 12px;">
              You received this because you signed up at example.com.
              <a href="https://example.com/unsubscribe/user123" style="color: #999;">Unsubscribe</a>
              |
              <a href="https://example.com/preferences" style="color: #999;">Manage preferences</a>
            </p>
          </td></tr>
        </table>
      `;
      expect(extractUnsubscribeUrl(html)).toBe("https://example.com/unsubscribe/user123");
    });

    it("handles unsubscribe link with surrounding text", () => {
      const html = `
        <p>To unsubscribe from future emails, <a href="https://example.com/unsubscribe?id=abc">click here to unsubscribe</a>.</p>
      `;
      expect(extractUnsubscribeUrl(html)).toBe("https://example.com/unsubscribe?id=abc");
    });
  });
});
