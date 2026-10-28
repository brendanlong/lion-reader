/**
 * Unit tests for content cleaner using Mozilla Readability.
 */

import { describe, it, expect } from "vitest";
import {
  cleanContent,
  absolutizeUrls,
  rewriteContentUrlsAsync,
  extractBaseHref,
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

    it("should reject pathologically nested HTML quickly (CPU-exhaustion guard)", () => {
      // Extraction cost grows super-linearly with DOM nesting depth, and this
      // runs on attacker-controlled feed HTML — the native module caps depth
      // at 512 and fails fast to the raw-content fallback. Unguarded, this
      // input takes minutes; guarded it returns null in tens of milliseconds.
      const bomb = "<div>".repeat(5000) + "some text content here" + "</div>".repeat(5000);
      const start = performance.now();
      const result = cleanContent(bomb);
      expect(result).toBeNull();
      expect(performance.now() - start).toBeLessThan(5000);
    });

    it("should still extract from deeply (but not pathologically) nested pages", () => {
      const deep =
        "<div>".repeat(400) +
        "<article><h1>Deep Title</h1>" +
        "<p>Real content paragraph with plenty of words for the extraction algorithm to keep.</p>".repeat(
          10
        ) +
        "</article>" +
        "</div>".repeat(400);
      const result = cleanContent(deep);
      expect(result).not.toBeNull();
      expect(result!.textContent).toContain("Real content paragraph");
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

    it("returns the page's meta description as the excerpt", () => {
      const html = `
        <html><head><meta name="description" content="A per-article description of the topic."></head>
        <body><article>
          <h1>Long Article</h1>
          <p>This is the opening paragraph that introduces the topic. It should not be the excerpt.</p>
          <p>The second paragraph continues with more detail about the subject matter.</p>
          <p>A third paragraph adds depth to the article content.</p>
        </article></body></html>
      `;

      expect(cleanContent(html)!.excerpt).toBe("A per-article description of the topic.");
    });

    it("leaves the excerpt empty without a description, rather than the first paragraph's raw text", () => {
      // summarizeCleanedContent summarizes the article HTML instead, applying the
      // summary rules (footnote markers, superscripts) that raw text would bypass.
      const html = `
        <article>
          <h1>Long Article</h1>
          <p>This is the opening paragraph that introduces the topic.<sup><a href="#fn1">1</a></sup></p>
          <p>The second paragraph continues with more detail about the subject matter.</p>
          <p>A third paragraph adds depth to the article content.</p>
        </article>
      `;

      expect(cleanContent(html)!.excerpt).toBe("");
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

// The rewriting rules are tested in native/sanitizer/core/src/absolutize.rs;
// these cover the wrapper and the binding.
describe("absolutizeUrls", () => {
  const baseUrl = "https://example.com/articles/test-article";

  it("passes the root and media bases through", () => {
    const html = '<img src="/i/p.jpg"><a href="/d/o.md">x</a>';
    const result = absolutizeUrls(html, "https://example.com/tree/main/page.md", {
      rootBaseUrl: "https://example.com/tree/main/",
      media: {
        baseUrl: "https://cdn.example.com/main/page.md",
        rootBaseUrl: "https://cdn.example.com/main/",
      },
    });
    expect(result).toBe(
      '<img src="https://cdn.example.com/main/i/p.jpg"><a href="https://example.com/tree/main/d/o.md">x</a>'
    );
  });

  it("returns input the parser rejects unchanged", async () => {
    const rejected = '<select><xmp><img src="a.png"></xmp></select>';
    expect(absolutizeUrls(rejected, baseUrl)).toBe(rejected);
    const large = rejected + "<p>filler</p>".repeat(2000);
    await expect(rewriteContentUrlsAsync(large, baseUrl)).resolves.toEqual({
      html: large,
      images: [],
    });
  });

  it("gives the same result from the async form on large input", async () => {
    const html = '<p><img src="a.png"><a href="/b">x</a></p>'.repeat(1000);
    const expected = absolutizeUrls(html, baseUrl);
    expect(expected).toContain('src="https://example.com/articles/a.png"');
    await expect(rewriteContentUrlsAsync(html, baseUrl)).resolves.toEqual({
      html: expected,
      images: [],
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

    it("should use <base href> from raw HTML even after Readability strips it", () => {
      // Simulates the ArXiv case: URL without trailing slash, but <base> tag has one
      const html = `
        <!DOCTYPE html>
        <html>
        <head><base href="/html/2602.04118v1/"/></head>
        <body>
          <article>
            <h1>Paper Title</h1>
            <p>This is the first paragraph of the paper with enough content for Readability to consider it readable.</p>
            <img src="x1.png" alt="Figure 1">
            <p>This is the second paragraph with more detailed analysis of the results shown above.</p>
            <p>This is the third paragraph with conclusions and future work directions.</p>
          </article>
        </body>
        </html>
      `;

      const result = cleanContent(html, { url: "https://arxiv.org/html/2602.04118v1" });

      expect(result).not.toBeNull();
      // Should resolve against the <base href> (with trailing slash), not the URL
      expect(result!.content).toContain('src="https://arxiv.org/html/2602.04118v1/x1.png"');
    });
  });
});

describe("extractBaseHref", () => {
  it("should extract base href from HTML", () => {
    const html = '<html><head><base href="/html/paper/"/></head><body></body></html>';
    expect(extractBaseHref(html, "https://example.com/page")).toBe(
      "https://example.com/html/paper/"
    );
  });

  it("should return fallback URL when no base tag exists", () => {
    const html = "<html><head></head><body></body></html>";
    expect(extractBaseHref(html, "https://example.com/page")).toBe("https://example.com/page");
  });

  it("should handle absolute base href", () => {
    const html = '<html><head><base href="https://cdn.example.com/assets/"/></head></html>';
    expect(extractBaseHref(html, "https://example.com/page")).toBe(
      "https://cdn.example.com/assets/"
    );
  });

  it("should use only the first base tag per HTML spec", () => {
    const html =
      '<html><head><base href="/first/"/><base href="/second/"/></head><body></body></html>';
    expect(extractBaseHref(html, "https://example.com")).toBe("https://example.com/first/");
  });

  it("should handle base tag with other attributes", () => {
    const html = '<html><head><base target="_blank" href="/path/"/></head></html>';
    expect(extractBaseHref(html, "https://example.com")).toBe("https://example.com/path/");
  });

  it("should handle single-quoted href", () => {
    const html = "<html><head><base href='/path/'/></head></html>";
    expect(extractBaseHref(html, "https://example.com")).toBe("https://example.com/path/");
  });

  it("should return fallback when no href attribute in base tag", () => {
    const html = '<html><head><base target="_blank"></head></html>';
    expect(extractBaseHref(html, "https://example.com/page")).toBe("https://example.com/page");
  });

  it("stays linear on repeated unclosed <base fragments", () => {
    // `[^>]*` here took ~1.5s on this 120 KB input (quadratic).
    const hostile = "<base ".repeat(20000) + '><base href="/real/">';
    const started = performance.now();
    expect(extractBaseHref(hostile, "https://example.com")).toBe("https://example.com/real/");
    expect(performance.now() - started).toBeLessThan(200);
  });
});
