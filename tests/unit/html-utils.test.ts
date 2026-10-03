/**
 * Unit tests for HTML utilities.
 */

import { describe, it, expect } from "vitest";
import { escapeHtml, plainTextToHtml } from "@/server/http/html";

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
