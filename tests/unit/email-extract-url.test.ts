/**
 * Unit tests for extracting canonical URLs and unsubscribe URLs from newsletter email HTML.
 */

import { describe, it, expect } from "vitest";
import { extractEmailUrl, extractUnsubscribeUrl } from "@/server/email/extract-url";

describe("extractEmailUrl", () => {
  describe("view online text matching (primary strategy)", () => {
    it("extracts URL from Substack READ IN APP button", () => {
      const html = `
        <h1><a href="https://substack.com/app-link/post?publication_id=2355025&post_id=185204578">Title</a></h1>
        <p>Some content...</p>
        <a class="email-button-outline" href="https://open.substack.com/pub/cartoonshateher/p/the-rise-of-the-highfivesexuals?utm_source=email&redirect=app-store&utm_campaign=email-read-in-app">
          <span class="email-button-text">READ IN APP</span>
        </a>
      `;
      expect(extractEmailUrl(html)).toBe(
        "https://open.substack.com/pub/cartoonshateher/p/the-rise-of-the-highfivesexuals"
      );
    });

    it("extracts URL from 'Read Online' link in paragraph", () => {
      const html = `
        <p class="header" align="right">
          January 25, 2026 |
          <a href="https://leadershipintech.com/newsletters/2201?sid=eeba4afc">Read Online</a>
        </p>
        <h2><a href="https://leadershipintech.com/newsletters/2201?sid=eeba4afc">The hitchhiker's guide</a></h2>
      `;
      expect(extractEmailUrl(html)).toBe(
        "https://leadershipintech.com/newsletters/2201?sid=eeba4afc"
      );
    });

    it("extracts URL from 'View in your browser' link", () => {
      const html = `
        <a href="https://buttondown-0005.com/c/encodedtoken123">View in your browser</a>
        <h1><a href="https://example.com/post">Newsletter Title</a></h1>
      `;
      expect(extractEmailUrl(html)).toBe("https://buttondown-0005.com/c/encodedtoken123");
    });

    it("extracts URL from 'View in browser' with nested spans", () => {
      const html = `
        <td align="center">
          <a href="https://9nwl1.r.sp1-brevo.net/mk/mr/sh/abc123/def456">
            <span><u>View in browser</u></span>
          </a>
        </td>
        <h2>Level Up - Issue #340</h2>
      `;
      expect(extractEmailUrl(html)).toBe("https://9nwl1.r.sp1-brevo.net/mk/mr/sh/abc123/def456");
    });

    it("prefers view-online link over heading link", () => {
      const html = `
        <h1><a href="https://example.com/heading-url">Title</a></h1>
        <a href="https://example.com/view-online-url">View in browser</a>
      `;
      expect(extractEmailUrl(html)).toBe("https://example.com/view-online-url");
    });

    it("takes the first view-online match", () => {
      const html = `
        <a href="https://example.com/first">Read online</a>
        <a href="https://example.com/second">View in browser</a>
      `;
      expect(extractEmailUrl(html)).toBe("https://example.com/first");
    });

    it("skips view-online links with non-http protocols", () => {
      const html = `
        <a href="mailto:test@example.com">Read in app</a>
        <h1><a href="https://example.com/post">Title</a></h1>
      `;
      expect(extractEmailUrl(html)).toBe("https://example.com/post");
    });

    it("skips Substack app-link even with view-online text", () => {
      const html = `
        <a href="https://substack.com/app-link/post?publication_id=123&post_id=456">Read in app</a>
      `;
      expect(extractEmailUrl(html)).toBeNull();
    });

    it("does not filter view-online links by isContentUrl", () => {
      // Click-tracking URLs would fail isContentUrl but should be preserved
      // when the link text is "View in browser"
      const html = `
        <a href="https://click.convertkit-mail.com/redirect/abc123">View in browser</a>
      `;
      expect(extractEmailUrl(html)).toBe("https://click.convertkit-mail.com/redirect/abc123");
    });
  });

  describe("heading link fallback (secondary strategy)", () => {
    it("extracts URL from h1 > a when no view-online link", () => {
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

    it("takes first heading link", () => {
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

    it("strips tracking params from open.substack.com URLs", () => {
      const html = `
        <h1>
          <a href="https://open.substack.com/pub/test/p/my-post?utm_source=email&utm_campaign=test&r=abc">
            Test Post
          </a>
        </h1>
      `;
      expect(extractEmailUrl(html)).toBe("https://open.substack.com/pub/test/p/my-post");
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

  describe("URLs to skip", () => {
    it("skips mailto: links in headings", () => {
      const html = `
        <h1><a href="mailto:contact@example.com">Contact Us</a></h1>
      `;
      expect(extractEmailUrl(html)).toBeNull();
    });

    it("skips unsubscribe links in headings", () => {
      const html = `
        <h1><a href="https://example.com/unsubscribe?token=abc">Unsubscribe</a></h1>
      `;
      expect(extractEmailUrl(html)).toBeNull();
    });

    it("skips subscribe links in headings", () => {
      const html = `
        <h1><a href="https://example.com/subscribe?ref=email">Subscribe</a></h1>
      `;
      expect(extractEmailUrl(html)).toBeNull();
    });

    it("returns null when only heading has app-link and no view-online link", () => {
      const html = `
        <h1>
          <a href="https://substack.com/app-link/post?publication_id=89120&post_id=182110210">
            Title
          </a>
        </h1>
      `;
      expect(extractEmailUrl(html)).toBeNull();
    });

    it("ignores non-matching links outside heading elements", () => {
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

    it("returns null for HTML with no headings and no view-online links", () => {
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

  describe("real-world email fragments", () => {
    it("extracts URL from modern Substack email with app-link in h1 + READ IN APP button", () => {
      const html = `
        <table role="presentation" width="100%">
          <tbody><tr><td></td><td class="content" width="550" align="left">
            <div class="post typography" dir="auto">
              <div class="post-header" role="region">
                <h1 class="post-title published title-X77sOw" dir="auto">
                  <a href="https://substack.com/app-link/post?publication_id=2355025&amp;post_id=185204578&amp;utm_source=post-email-title&amp;isFreemail=false&amp;r=67xro&amp;token=abc123">
                    The Rise of the Highfivesexuals
                  </a>
                </h1>
                <h3 class="subtitle">A subtitle</h3>
              </div>
            </div>
            <div class="post typography" dir="auto">
              <div class="body markup" dir="auto">
                <p>Content here...</p>
              </div>
            </div>
            <a class="email-button-outline" href="https://open.substack.com/pub/cartoonshateher/p/the-rise-of-the-highfivesexuals?utm_source=email&amp;redirect=app-store&amp;utm_campaign=email-read-in-app">
              <span class="email-button-text">READ IN APP</span>
            </a>
          </td><td></td></tr></tbody>
        </table>
      `;
      expect(extractEmailUrl(html)).toBe(
        "https://open.substack.com/pub/cartoonshateher/p/the-rise-of-the-highfivesexuals"
      );
    });

    it("extracts URL from older Substack email with open.substack.com in heading", () => {
      const html = `
        <table role="presentation" width="100%">
          <tbody><tr><td></td><td class="content" width="550" align="left">
            <div class="post typography" dir="auto">
              <div class="post-header" role="region">
                <h1 class="post-title published title-X77sOw" dir="auto">
                  <a href="https://open.substack.com/pub/astralcodexten/p/political-backflow-from-europe?utm_source=post-email-title&amp;utm_campaign=email-post-title&amp;isFreemail=false&amp;r=67xro&amp;token=abc123" target="_blank" rel="noopener noreferrer">
                    Political Backflow From Europe
                  </a>
                </h1>
                <h3 class="subtitle">Some subtitle text...</h3>
              </div>
            </div>
          </td><td></td></tr></tbody>
        </table>
      `;
      expect(extractEmailUrl(html)).toBe(
        "https://open.substack.com/pub/astralcodexten/p/political-backflow-from-europe"
      );
    });

    it("extracts URL from non-Substack newsletter with Read Online link", () => {
      const html = `
        <table>
          <tr><td>
            <p class="header" align="right">
              January 25, 2026 |
              <a href="https://leadershipintech.com/newsletters/2201?sid=eeba4afc-782f-49c1-937b-a52e11104ea0" style="color: #ec615c;">Read Online</a>
            </p>
            <h2><a href="https://leadershipintech.com/links/21280/abc/email">The hitchhiker's guide to measuring engineering ROI</a></h2>
            <p>Content...</p>
          </td></tr>
        </table>
      `;
      expect(extractEmailUrl(html)).toBe(
        "https://leadershipintech.com/newsletters/2201?sid=eeba4afc-782f-49c1-937b-a52e11104ea0"
      );
    });

    it("extracts click-tracking URL from Buttondown 'View in your browser'", () => {
      const html = `
        <div>
          <a href="https://buttondown-0005.com/c/NDcyMjg1NDEtZjg0Mi00MTk5LTliODEtYzlkNzQ4OTkwNTI3">View in your browser</a>
          <h1>Hacker Newsletter #781</h1>
          <p>Top links this week...</p>
        </div>
      `;
      expect(extractEmailUrl(html)).toBe(
        "https://buttondown-0005.com/c/NDcyMjg1NDEtZjg0Mi00MTk5LTliODEtYzlkNzQ4OTkwNTI3"
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
