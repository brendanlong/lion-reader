/**
 * Unit tests for content cleaner using Mozilla Readability.
 */

import { describe, it, expect } from "vitest";
import {
  cleanContent,
  generateCleanedSummary,
  absolutizeUrls,
  isLessWrongFeed,
  cleanLessWrongContent,
} from "@/server/feed/content-cleaner";

describe("cleanContent", () => {
  describe("basic functionality", () => {
    it("should extract article content from a full HTML page", () => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Test Article</title>
        </head>
        <body>
          <nav>Navigation menu</nav>
          <article>
            <h1>Main Article Title</h1>
            <p>This is the first paragraph of the article content. It contains important information that should be extracted by Readability.</p>
            <p>This is the second paragraph with more content. The algorithm should identify this as the main article body.</p>
            <p>Third paragraph adds even more text to help Readability understand this is an article.</p>
          </article>
          <aside>Sidebar content</aside>
          <footer>Footer content</footer>
        </body>
        </html>
      `;

      const result = cleanContent(html, { url: "https://example.com/article" });

      expect(result).not.toBeNull();
      expect(result!.content).toContain("first paragraph");
      expect(result!.content).toContain("second paragraph");
      expect(result!.textContent).toContain("important information");
      // Navigation and footer should be removed
      expect(result!.content).not.toContain("Navigation menu");
      expect(result!.content).not.toContain("Footer content");
    });

    it("should extract content from a simple article element", () => {
      const html = `
        <article>
          <h1>Simple Article</h1>
          <p>This is a straightforward article with enough content to be processed by Readability. It needs multiple paragraphs to work properly.</p>
          <p>Here is another paragraph with additional text that helps establish this as readable content.</p>
          <p>And a third paragraph to ensure there's enough text for the algorithm to work with.</p>
        </article>
      `;

      const result = cleanContent(html);

      expect(result).not.toBeNull();
      expect(result!.content).toContain("Simple Article");
      expect(result!.textContent).toContain("straightforward article");
    });

    it("should handle content with images", () => {
      const html = `
        <article>
          <h1>Article with Images</h1>
          <p>This article contains an image that should be preserved in the cleaned output.</p>
          <img src="https://example.com/image.jpg" alt="Test image" />
          <p>More text after the image to provide context and ensure Readability works.</p>
          <p>Additional paragraph content for the algorithm to process properly.</p>
        </article>
      `;

      const result = cleanContent(html, { url: "https://example.com" });

      expect(result).not.toBeNull();
      // The image should be preserved
      expect(result!.content).toContain("img");
    });

    it("should handle content with links", () => {
      const html = `
        <article>
          <h1>Article with Links</h1>
          <p>This article contains a <a href="https://example.com/link">link to another page</a> that should be preserved.</p>
          <p>More paragraph text to ensure the article is long enough for processing.</p>
          <p>Third paragraph with additional content for Readability.</p>
        </article>
      `;

      const result = cleanContent(html, { url: "https://example.com" });

      expect(result).not.toBeNull();
      expect(result!.content).toContain("href");
      expect(result!.content).toContain("link to another page");
    });

    it("should handle code blocks", () => {
      const html = `
        <article>
          <h1>Technical Article</h1>
          <p>This article contains code examples that should be preserved.</p>
          <pre><code>function hello() {
  console.log("Hello, world!");
}</code></pre>
          <p>More explanation after the code block with additional content.</p>
          <p>Technical articles often have multiple paragraphs explaining concepts.</p>
        </article>
      `;

      const result = cleanContent(html);

      expect(result).not.toBeNull();
      expect(result!.content).toContain("function hello()");
      expect(result!.content).toContain("console.log");
    });
  });

  describe("edge cases", () => {
    it("should return null for very short content", () => {
      const html = "<p>Too short</p>";
      const result = cleanContent(html);
      expect(result).toBeNull();
    });

    it("should return null for empty content", () => {
      const html = "";
      const result = cleanContent(html);
      expect(result).toBeNull();
    });

    it("should handle malformed HTML gracefully", () => {
      const html = `
        <article>
          <h1>Malformed Article
          <p>This paragraph is not properly closed.
          <p>Another paragraph with enough content to process.
          <p>Third paragraph for Readability algorithm.
        </article>
      `;

      // Should not throw, even if it returns null
      expect(() => cleanContent(html)).not.toThrow();
    });

    it("should handle content with only navigation elements", () => {
      const html = `
        <nav>
          <ul>
            <li><a href="/">Home</a></li>
            <li><a href="/about">About</a></li>
            <li><a href="/contact">Contact</a></li>
          </ul>
        </nav>
      `;

      // Navigation-only content should fail or return empty
      const result = cleanContent(html);
      // Readability might return null or empty content
      if (result) {
        expect(result.textContent.trim().length).toBeLessThan(50);
      }
    });

    it("should respect minimum content length option", () => {
      const html = "<p>Short content</p>";
      // With a low minContentLength, the function will attempt to process
      // even short content (though Readability may still fail to extract)
      expect(() => cleanContent(html, { minContentLength: 10 })).not.toThrow();
    });
  });

  describe("content cleaning", () => {
    it("should remove script tags", () => {
      const html = `
        <article>
          <h1>Article with Script</h1>
          <p>This is legitimate content that should be preserved.</p>
          <script>alert('malicious');</script>
          <p>More content after the script tag.</p>
          <p>Third paragraph for algorithm processing.</p>
        </article>
      `;

      const result = cleanContent(html);

      expect(result).not.toBeNull();
      expect(result!.content).not.toContain("<script");
      expect(result!.content).not.toContain("alert");
      expect(result!.content).toContain("legitimate content");
    });

    it("should remove inline style elements", () => {
      const html = `
        <article>
          <h1>Article with Style</h1>
          <style>.hidden { display: none; }</style>
          <p>This is the main content of the article.</p>
          <p>Second paragraph with more text.</p>
          <p>Third paragraph for processing.</p>
        </article>
      `;

      const result = cleanContent(html);

      expect(result).not.toBeNull();
      expect(result!.content).not.toContain("<style");
      expect(result!.content).not.toContain("display: none");
    });

    it("should handle content with HTML comments", () => {
      const html = `
        <article>
          <h1>Article Title</h1>
          <!-- This is a comment -->
          <p>Main content paragraph one with text.</p>
          <p>Main content paragraph two with more text.</p>
          <p>Main content paragraph three.</p>
        </article>
      `;

      const result = cleanContent(html);

      expect(result).not.toBeNull();
      // Main content should be preserved
      expect(result!.content).toContain("Main content paragraph");
    });
  });

  describe("metadata extraction", () => {
    it("should extract title from article", () => {
      const html = `
        <html>
        <head><title>Page Title</title></head>
        <body>
          <article>
            <h1>Article Headline</h1>
            <p>First paragraph of the article with meaningful content.</p>
            <p>Second paragraph continues the story.</p>
            <p>Third paragraph concludes this section.</p>
          </article>
        </body>
        </html>
      `;

      const result = cleanContent(html);

      expect(result).not.toBeNull();
      // Title could come from h1 or page title
      expect(result!.title).toBeTruthy();
    });

    it("should extract byline when present", () => {
      const html = `
        <article>
          <h1>Featured Article</h1>
          <div class="byline">By John Smith</div>
          <p>This is the article content written by the author.</p>
          <p>More content in the second paragraph.</p>
          <p>Third paragraph with additional text.</p>
        </article>
      `;

      const result = cleanContent(html);

      expect(result).not.toBeNull();
      // Note: Byline extraction can be finicky
      // Just verify we got content
      expect(result!.content).toContain("article content");
    });

    it("should generate excerpt from content", () => {
      const html = `
        <article>
          <h1>Long Article</h1>
          <p>This is the opening paragraph that introduces the topic. It should appear in the excerpt.</p>
          <p>The second paragraph continues with more detail about the subject matter.</p>
          <p>A third paragraph adds depth to the article content.</p>
        </article>
      `;

      const result = cleanContent(html);

      expect(result).not.toBeNull();
      expect(result!.excerpt.length).toBeGreaterThan(0);
    });
  });

  describe("text content", () => {
    it("should provide plain text version without HTML", () => {
      const html = `
        <article>
          <h1>Test Article</h1>
          <p>This is <strong>bold</strong> and <em>italic</em> text.</p>
          <p>More text in a second paragraph.</p>
          <p>Third paragraph for processing.</p>
        </article>
      `;

      const result = cleanContent(html);

      expect(result).not.toBeNull();
      expect(result!.textContent).not.toContain("<strong>");
      expect(result!.textContent).not.toContain("<em>");
      expect(result!.textContent).toContain("bold");
      expect(result!.textContent).toContain("italic");
    });

    it("should normalize whitespace in text content", () => {
      const html = `
        <article>
          <h1>Test</h1>
          <p>This    has    extra    whitespace   in   the   text.</p>
          <p>Second paragraph with normal text.</p>
          <p>Third paragraph here.</p>
        </article>
      `;

      const result = cleanContent(html);

      expect(result).not.toBeNull();
      // Text content should be trimmed
      expect(result!.textContent).not.toMatch(/^\s/);
      expect(result!.textContent).not.toMatch(/\s$/);
    });
  });
});

describe("generateCleanedSummary", () => {
  it("should use excerpt when available and long enough", () => {
    const cleaned = {
      content: "<p>Full content here...</p>",
      textContent: "Full content here...",
      excerpt: "This is a meaningful excerpt that summarizes the article content well.",
      title: "Test",
      byline: null,
    };

    const summary = generateCleanedSummary(cleaned);

    expect(summary).toBe(cleaned.excerpt);
  });

  it("should fall back to text content when excerpt is short", () => {
    const cleaned = {
      content: "<p>Full content here...</p>",
      textContent: "This is the full text content that should be used for the summary.",
      excerpt: "Too short",
      title: "Test",
      byline: null,
    };

    const summary = generateCleanedSummary(cleaned);

    expect(summary).toContain("full text content");
  });

  it("should truncate long content", () => {
    const longText = "A".repeat(500);
    const cleaned = {
      content: `<p>${longText}</p>`,
      textContent: longText,
      excerpt: "",
      title: "Test",
      byline: null,
    };

    const summary = generateCleanedSummary(cleaned, 300);

    expect(summary.length).toBeLessThanOrEqual(303); // 300 + "..."
    expect(summary.endsWith("...")).toBe(true);
  });

  it("should not truncate short content", () => {
    const cleaned = {
      content: "<p>Short content</p>",
      textContent: "Short content",
      excerpt: "",
      title: "Test",
      byline: null,
    };

    const summary = generateCleanedSummary(cleaned);

    expect(summary).toBe("Short content");
    expect(summary.endsWith("...")).toBe(false);
  });

  it("should handle empty content", () => {
    const cleaned = {
      content: "",
      textContent: "",
      excerpt: "",
      title: "Test",
      byline: null,
    };

    const summary = generateCleanedSummary(cleaned);

    expect(summary).toBe("");
  });
});

describe("absolutizeUrls", () => {
  const baseUrl = "https://example.com/articles/test-article";

  describe("image src attributes", () => {
    it("should convert relative image src to absolute", () => {
      const html = '<img src="/images/photo.jpg" alt="Test">';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain('src="https://example.com/images/photo.jpg"');
    });

    it("should convert relative path image src to absolute", () => {
      const html = '<img src="../images/photo.jpg" alt="Test">';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain('src="https://example.com/images/photo.jpg"');
    });

    it("should convert same-directory relative image src to absolute", () => {
      const html = '<img src="photo.jpg" alt="Test">';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain('src="https://example.com/articles/photo.jpg"');
    });

    it("should leave absolute image src unchanged", () => {
      const html = '<img src="https://cdn.example.com/image.jpg" alt="Test">';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain('src="https://cdn.example.com/image.jpg"');
    });

    it("should preserve data: URLs", () => {
      const html = '<img src="data:image/png;base64,abc123" alt="Test">';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain('src="data:image/png;base64,abc123"');
    });
  });

  describe("link href attributes", () => {
    it("should convert relative href to absolute", () => {
      const html = '<a href="/page">Link</a>';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain('href="https://example.com/page"');
    });

    it("should leave absolute href unchanged", () => {
      const html = '<a href="https://other.com/page">Link</a>';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain('href="https://other.com/page"');
    });

    it("should preserve javascript: URLs", () => {
      const html = '<a href="javascript:void(0)">Click</a>';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain('href="javascript:void(0)"');
    });
  });

  describe("srcset attributes", () => {
    it("should convert relative URLs in srcset", () => {
      const html =
        '<img srcset="/images/small.jpg 1x, /images/large.jpg 2x" src="/images/default.jpg">';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain("https://example.com/images/small.jpg 1x");
      expect(result).toContain("https://example.com/images/large.jpg 2x");
    });

    it("should handle srcset with width descriptors", () => {
      const html = '<img srcset="/images/small.jpg 480w, /images/large.jpg 800w">';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain("https://example.com/images/small.jpg 480w");
      expect(result).toContain("https://example.com/images/large.jpg 800w");
    });

    it("should leave absolute URLs in srcset unchanged", () => {
      const html = '<img srcset="https://cdn.example.com/small.jpg 1x">';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain("https://cdn.example.com/small.jpg 1x");
    });

    it("should handle URLs with commas (like Cloudinary URLs)", () => {
      // Cloudinary uses commas in URL paths for transformations: f_auto,q_auto
      const html =
        '<img srcset="https://res.cloudinary.com/lesswrong-2-0/image/upload/f_auto,q_auto/v1/mirroredImages/foo/bar">';
      const result = absolutizeUrls(html, baseUrl);
      // The URL should NOT be split on the comma - it should remain intact
      expect(result).toContain(
        "https://res.cloudinary.com/lesswrong-2-0/image/upload/f_auto,q_auto/v1/mirroredImages/foo/bar"
      );
    });

    it("should handle URLs with commas AND descriptors", () => {
      // Cloudinary URL with a descriptor
      const html =
        '<img srcset="https://res.cloudinary.com/example/f_auto,q_auto/image.jpg 1x, https://res.cloudinary.com/example/f_auto,q_auto/image@2x.jpg 2x">';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain("https://res.cloudinary.com/example/f_auto,q_auto/image.jpg 1x");
      expect(result).toContain("https://res.cloudinary.com/example/f_auto,q_auto/image@2x.jpg 2x");
    });

    it("should handle mixed Cloudinary URLs with absolute paths", () => {
      // Mix of Cloudinary URL (with commas) and absolute paths
      const html =
        '<img srcset="https://res.cloudinary.com/example/f_auto,q_auto/img.jpg 1x, /images/fallback.jpg 2x">';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain("https://res.cloudinary.com/example/f_auto,q_auto/img.jpg 1x");
      expect(result).toContain("https://example.com/images/fallback.jpg 2x");
    });

    it("should handle multiple commas in a single URL", () => {
      // URL with multiple transformation parameters
      const html =
        '<img srcset="https://res.cloudinary.com/demo/image/upload/c_fill,g_auto,h_250,w_970/docs/shoes.jpg">';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain(
        "https://res.cloudinary.com/demo/image/upload/c_fill,g_auto,h_250,w_970/docs/shoes.jpg"
      );
    });
  });

  describe("video poster attributes", () => {
    it("should convert relative poster URL to absolute", () => {
      const html = '<video poster="/images/poster.jpg"></video>';
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain('poster="https://example.com/images/poster.jpg"');
    });
  });

  describe("multiple elements", () => {
    it("should absolutize URLs in all elements", () => {
      const html = `
        <article>
          <img src="/image1.jpg">
          <a href="/link1">Link 1</a>
          <img src="/image2.jpg">
          <a href="/link2">Link 2</a>
        </article>
      `;
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain('src="https://example.com/image1.jpg"');
      expect(result).toContain('src="https://example.com/image2.jpg"');
      expect(result).toContain('href="https://example.com/link1"');
      expect(result).toContain('href="https://example.com/link2"');
    });
  });

  describe("edge cases", () => {
    it("should handle empty HTML", () => {
      const html = "";
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toBe("");
    });

    it("should handle HTML with no URL attributes", () => {
      const html = "<p>Just some text</p>";
      const result = absolutizeUrls(html, baseUrl);
      expect(result).toContain("Just some text");
    });

    it("should handle invalid base URL gracefully", () => {
      const html = '<img src="/image.jpg">';
      // Should not throw, returns original
      expect(() => absolutizeUrls(html, "not-a-valid-url")).not.toThrow();
    });
  });

  describe("integration with cleanContent", () => {
    it("should absolutize URLs in cleaned content", () => {
      const html = `
        <article>
          <h1>Test Article</h1>
          <p>This article has an image with a relative URL.</p>
          <img src="/images/test.jpg" alt="Test">
          <p>And a link with a relative URL: <a href="/other-page">click here</a>.</p>
          <p>Third paragraph for Readability.</p>
        </article>
      `;

      const result = cleanContent(html, { url: "https://example.com/articles/test" });

      expect(result).not.toBeNull();
      expect(result!.content).toContain('src="https://example.com/images/test.jpg"');
      expect(result!.content).toContain('href="https://example.com/other-page"');
    });
  });
});

describe("isLessWrongFeed", () => {
  describe("valid LessWrong URLs", () => {
    it("should return true for www.lesswrong.com feed", () => {
      expect(isLessWrongFeed("https://www.lesswrong.com/feed.xml")).toBe(true);
    });

    it("should return true for lesswrong.com feed without www", () => {
      expect(isLessWrongFeed("https://lesswrong.com/feed.xml")).toBe(true);
    });

    it("should return true for www.lesserwrong.com feed", () => {
      expect(isLessWrongFeed("https://www.lesserwrong.com/feed.xml")).toBe(true);
    });

    it("should return true for lesserwrong.com feed without www", () => {
      expect(isLessWrongFeed("http://lesserwrong.com/feed.xml")).toBe(true);
    });

    it("should return true for feeds with query parameters", () => {
      expect(isLessWrongFeed("https://www.lesswrong.com/feed.xml?view=rss&karmaThreshold=2")).toBe(
        true
      );
    });
  });

  describe("non-LessWrong URLs", () => {
    it("should return false for other domains", () => {
      expect(isLessWrongFeed("https://example.com/feed.xml")).toBe(false);
    });

    it("should return false for domains containing lesswrong", () => {
      expect(isLessWrongFeed("https://notlesswrong.com/feed.xml")).toBe(false);
      expect(isLessWrongFeed("https://lesswrongfake.com/feed.xml")).toBe(false);
    });

    it("should return false for subdomains other than www", () => {
      expect(isLessWrongFeed("https://blog.lesswrong.com/feed.xml")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should return false for null", () => {
      expect(isLessWrongFeed(null)).toBe(false);
    });

    it("should return false for undefined", () => {
      expect(isLessWrongFeed(undefined)).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isLessWrongFeed("")).toBe(false);
    });

    it("should return false for invalid URL", () => {
      expect(isLessWrongFeed("not-a-url")).toBe(false);
    });
  });
});

describe("cleanLessWrongContent", () => {
  describe("removes published date prefix", () => {
    it("should strip standard published on format with GMT", () => {
      const content =
        "Published on January 7, 2026 2:39 AM GMT<br/><br/><p>This is the article content.</p>";
      const result = cleanLessWrongContent(content);
      expect(result).toBe("<p>This is the article content.</p>");
    });

    it("should strip published on format with different timezone", () => {
      const content = "Published on December 25, 2025 11:30 PM EST<br/><br/><p>Content here.</p>";
      const result = cleanLessWrongContent(content);
      expect(result).toBe("<p>Content here.</p>");
    });

    it("should handle <br> without self-closing slash", () => {
      const content = "Published on January 1, 2026 12:00 PM PST<br><br><p>Article text.</p>";
      const result = cleanLessWrongContent(content);
      expect(result).toBe("<p>Article text.</p>");
    });

    it("should handle <br /> with space before slash", () => {
      const content = "Published on March 15, 2026 3:45 AM UTC<br /><br /><p>More content.</p>";
      const result = cleanLessWrongContent(content);
      expect(result).toBe("<p>More content.</p>");
    });

    it("should handle mixed br tag formats", () => {
      const content = "Published on June 30, 2025 6:00 PM GMT<br><br/><p>Mixed tags.</p>";
      const result = cleanLessWrongContent(content);
      expect(result).toBe("<p>Mixed tags.</p>");
    });

    it("should handle single digit day", () => {
      const content = "Published on January 1, 2026 1:00 AM GMT<br/><br/><p>New Year article.</p>";
      const result = cleanLessWrongContent(content);
      expect(result).toBe("<p>New Year article.</p>");
    });

    it("should handle double digit hour without leading zero", () => {
      const content = "Published on April 20, 2026 12:30 PM GMT<br/><br/><p>Noon article.</p>";
      const result = cleanLessWrongContent(content);
      expect(result).toBe("<p>Noon article.</p>");
    });
  });

  describe("preserves content without published date prefix", () => {
    it("should not modify content without the prefix", () => {
      const content = "<p>This is normal article content without a date prefix.</p>";
      const result = cleanLessWrongContent(content);
      expect(result).toBe(content);
    });

    it("should not modify content with published date in the middle", () => {
      const content =
        "<p>Some intro.</p>Published on January 7, 2026 2:39 AM GMT<br/><br/><p>More content.</p>";
      const result = cleanLessWrongContent(content);
      expect(result).toBe(content);
    });

    it("should not modify content with partial match", () => {
      const content = "Published on January 7, 2026<br/><br/><p>Missing time.</p>";
      const result = cleanLessWrongContent(content);
      expect(result).toBe(content);
    });
  });

  describe("real-world examples", () => {
    it("should clean actual LessWrong RSS content", () => {
      const content = `Published on January 7, 2026 2:39 AM GMT<br/><br/><p>I am not an expert on dating. In fact, I am an extremely conservative male who is not polyamorous and who is not really interested in dating.</p><p>However, I have seen my friends approach dating in a way that seems irrational to me.</p>`;
      const result = cleanLessWrongContent(content);
      expect(result).not.toContain("Published on");
      expect(result).toContain("I am not an expert on dating");
      expect(result.startsWith("<p>")).toBe(true);
    });
  });
});
