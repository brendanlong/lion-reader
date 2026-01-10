/**
 * Unit tests for HTML utilities.
 */

import { describe, it, expect } from "vitest";
import { escapeHtml, extractTextFromHtml } from "@/server/http/html";

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

describe("extractTextFromHtml", () => {
  it("should extract text from simple HTML", () => {
    const html = "<p>Hello <strong>world</strong>!</p>";
    expect(extractTextFromHtml(html)).toBe("Hello world!");
  });

  it("should remove script tags and their content", () => {
    const html = `
      <div>
        <script>alert('bad');</script>
        <p>Visible content</p>
      </div>
    `;
    expect(extractTextFromHtml(html)).toBe("Visible content");
  });

  it("should remove style tags and their content", () => {
    const html = `
      <div>
        <style>.hidden { display: none; }</style>
        <p>Visible text</p>
      </div>
    `;
    expect(extractTextFromHtml(html)).toBe("Visible text");
  });

  it("should collapse whitespace", () => {
    const html = "<p>Multiple    spaces\n\nand\nnewlines</p>";
    expect(extractTextFromHtml(html)).toBe("Multiple spaces and newlines");
  });

  it("should handle nested elements", () => {
    const html = `
      <article>
        <h1>Title</h1>
        <p>First <em>paragraph</em> here.</p>
        <p>Second paragraph.</p>
      </article>
    `;
    expect(extractTextFromHtml(html)).toBe("Title First paragraph here. Second paragraph.");
  });

  it("should handle empty HTML", () => {
    expect(extractTextFromHtml("")).toBe("");
    expect(extractTextFromHtml("<div></div>")).toBe("");
  });

  it("should decode HTML entities", () => {
    const html = "<p>&lt;Hello&gt; &amp; &quot;world&quot;</p>";
    expect(extractTextFromHtml(html)).toBe('<Hello> & "world"');
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
    const result = extractTextFromHtml(html);
    expect(result).toContain("Main content here");
    expect(result).toContain("Navigation");
    expect(result).toContain("Footer");
    // Title might or might not be included depending on DOM structure
  });
});
