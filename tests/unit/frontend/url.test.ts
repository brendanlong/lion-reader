/**
 * Unit tests for URL utility functions.
 *
 * Tests the normalizeUrl function which strips URL fragments.
 */

import { describe, it, expect } from "vitest";
import { normalizeUrl } from "@/lib/url";

describe("normalizeUrl", () => {
  describe("removing fragments", () => {
    it("removes hash fragments from URLs", () => {
      expect(normalizeUrl("https://example.com/article#section-2")).toBe(
        "https://example.com/article"
      );
    });

    it("removes fragments while preserving query parameters", () => {
      expect(normalizeUrl("https://example.com/page?q=test#top")).toBe(
        "https://example.com/page?q=test"
      );
    });

    it("removes empty fragments", () => {
      expect(normalizeUrl("https://example.com/page#")).toBe("https://example.com/page");
    });
  });

  describe("URLs without fragments", () => {
    it("returns URLs without fragments unchanged", () => {
      expect(normalizeUrl("https://example.com/article")).toBe("https://example.com/article");
    });

    it("preserves trailing slashes", () => {
      expect(normalizeUrl("https://example.com/path/")).toBe("https://example.com/path/");
    });
  });

  describe("invalid URLs", () => {
    it("returns invalid URLs as-is", () => {
      expect(normalizeUrl("not a url")).toBe("not a url");
    });

    it("returns empty strings as-is", () => {
      expect(normalizeUrl("")).toBe("");
    });

    it("returns relative paths as-is", () => {
      expect(normalizeUrl("/path/to/page#section")).toBe("/path/to/page#section");
    });
  });
});
