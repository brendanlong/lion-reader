/**
 * Unit tests for HTML utilities.
 */

import { describe, it, expect } from "vitest";
import { escapeHtml, plainTextToHtml } from "@/server/http/html";
import { stripHtml } from "@/server/html/strip-html";

describe("escapeHtml", () => {
  it("should escape ampersands", () => {
    expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
  });

  it("should escape angle brackets", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;"
    );
  });

  it("should escape quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
    expect(escapeHtml("it's")).toBe("it&#039;s");
  });

  it("should handle empty strings", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("should handle strings with no special characters", () => {
    expect(escapeHtml("plain text")).toBe("plain text");
  });
});

describe("plainTextToHtml", () => {
  it("escapes HTML in the text", () => {
    expect(plainTextToHtml("a <script>alert(1)</script> & b")).toBe(
      "<p>a &lt;script&gt;alert(1)&lt;/script&gt; &amp; b</p>"
    );
  });

  it("splits paragraphs on blank lines and lines on single newlines", () => {
    expect(plainTextToHtml("para one\nline two\n\npara two")).toBe(
      "<p>para one<br>line two</p><p>para two</p>"
    );
  });

  it("links bare URLs, trimming trailing punctuation", () => {
    expect(plainTextToHtml("See https://example.com/page. Done")).toBe(
      '<p>See <a href="https://example.com/page">https://example.com/page</a>. Done</p>'
    );
    expect(plainTextToHtml("(see https://example.com/page)")).toBe(
      '<p>(see <a href="https://example.com/page">https://example.com/page</a>)</p>'
    );
  });

  it("keeps escaped query separators in linked URLs", () => {
    expect(plainTextToHtml("https://example.com/x?a=1&b=2")).toBe(
      '<p><a href="https://example.com/x?a=1&amp;b=2">https://example.com/x?a=1&amp;b=2</a></p>'
    );
  });

  it("returns an empty string for blank input", () => {
    expect(plainTextToHtml("")).toBe("");
    expect(plainTextToHtml("  \n\n  ")).toBe("");
  });
});

describe("stripHtml", () => {
  it("should extract text from simple HTML", () => {
    const html = "<p>Hello <strong>world</strong>!</p>";
    expect(stripHtml(html)).toBe("Hello world!");
  });

  it("should remove script tags and their content", () => {
    const html = `
      <div>
        <script>alert('bad');</script>
        <p>Visible content</p>
      </div>
    `;
    expect(stripHtml(html)).toBe("Visible content");
  });

  it("should remove style tags and their content", () => {
    const html = `
      <div>
        <style>.hidden { display: none; }</style>
        <p>Visible text</p>
      </div>
    `;
    expect(stripHtml(html)).toBe("Visible text");
  });

  it("should collapse whitespace", () => {
    const html = "<p>Multiple    spaces\n\nand\nnewlines</p>";
    expect(stripHtml(html)).toBe("Multiple spaces and newlines");
  });

  it("should handle nested elements", () => {
    const html = `
      <article>
        <h1>Title</h1>
        <p>First <em>paragraph</em> here.</p>
        <p>Second paragraph.</p>
      </article>
    `;
    expect(stripHtml(html)).toBe("Title First paragraph here. Second paragraph.");
  });

  it("should handle empty HTML", () => {
    expect(stripHtml("")).toBe("");
    expect(stripHtml("<div></div>")).toBe("");
  });

  it("should decode HTML entities", () => {
    const html = "<p>&lt;Hello&gt; &amp; &quot;world&quot;</p>";
    expect(stripHtml(html)).toBe('<Hello> & "world"');
  });

  it("should handle full HTML document", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Page Title</title></head>
        <body>
          <nav>Navigation</nav>
          <main>Main content here</main>
          <footer>Footer</footer>
        </body>
      </html>
    `;
    const result = stripHtml(html);
    expect(result).toContain("Main content here");
    expect(result).toContain("Navigation");
    expect(result).toContain("Footer");
    // Title might or might not be included depending on DOM structure
  });
});
