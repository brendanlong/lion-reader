/**
 * Unit tests for URL normalization utilities.
 */

import { describe, it, expect } from "vitest";
import { normalizeUrl, safeDecodeURIComponent } from "../../src/lib/url";

describe("normalizeUrl", () => {
  it("strips fragment from URL", () => {
    expect(normalizeUrl("https://example.com/article#section-2")).toBe(
      "https://example.com/article"
    );
  });

  it("strips fragment with complex hash", () => {
    expect(normalizeUrl("https://example.com/page#:~:text=highlighted")).toBe(
      "https://example.com/page"
    );
  });

  it("preserves query parameters when stripping fragment", () => {
    expect(normalizeUrl("https://example.com/page?q=test#top")).toBe(
      "https://example.com/page?q=test"
    );
  });

  it("returns URL unchanged if no fragment", () => {
    expect(normalizeUrl("https://example.com/article")).toBe("https://example.com/article");
  });

  it("handles URL with only fragment", () => {
    expect(normalizeUrl("https://example.com/#section")).toBe("https://example.com/");
  });

  it("handles URL with empty fragment", () => {
    expect(normalizeUrl("https://example.com/page#")).toBe("https://example.com/page");
  });

  it("handles URL with port and fragment", () => {
    expect(normalizeUrl("https://example.com:8080/path#section")).toBe(
      "https://example.com:8080/path"
    );
  });

  it("handles URL with auth and fragment", () => {
    expect(normalizeUrl("https://user:pass@example.com/page#top")).toBe(
      "https://user:pass@example.com/page"
    );
  });

  it("returns invalid URL unchanged", () => {
    expect(normalizeUrl("not-a-valid-url")).toBe("not-a-valid-url");
  });

  it("returns empty string unchanged", () => {
    expect(normalizeUrl("")).toBe("");
  });
});

describe("safeDecodeURIComponent", () => {
  it("decodes a well-formed component", () => {
    expect(safeDecodeURIComponent("urn%3Ali%3Aactivity%3A123")).toBe("urn:li:activity:123");
  });

  it("returns the input unchanged for a malformed escape instead of throwing", () => {
    // `new URL()` and `z.string().url()` both accept these, so anything that
    // decodes a path segment out of a user-supplied URL must survive them.
    for (const malformed of ["%", "%E0%A4%A", "%ZZ", "100%"]) {
      expect(safeDecodeURIComponent(malformed)).toBe(malformed);
    }
  });
});
