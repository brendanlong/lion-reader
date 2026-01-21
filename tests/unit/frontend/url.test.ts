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

    it("removes fragments with complex anchor names", () => {
      expect(normalizeUrl("https://example.com/doc#heading-with-dashes_and_underscores")).toBe(
        "https://example.com/doc"
      );
    });
  });

  describe("URLs without fragments", () => {
    it("returns URLs without fragments unchanged", () => {
      expect(normalizeUrl("https://example.com/article")).toBe("https://example.com/article");
    });

    it("preserves query parameters on URLs without fragments", () => {
      expect(normalizeUrl("https://example.com/search?q=hello&page=2")).toBe(
        "https://example.com/search?q=hello&page=2"
      );
    });

    it("preserves trailing slashes", () => {
      expect(normalizeUrl("https://example.com/path/")).toBe("https://example.com/path/");
    });
  });

  describe("different URL schemes", () => {
    it("handles http URLs", () => {
      expect(normalizeUrl("http://example.com/page#anchor")).toBe("http://example.com/page");
    });

    it("handles URLs with ports", () => {
      expect(normalizeUrl("https://example.com:8080/api#section")).toBe(
        "https://example.com:8080/api"
      );
    });

    it("handles URLs with authentication", () => {
      expect(normalizeUrl("https://user:pass@example.com/path#hash")).toBe(
        "https://user:pass@example.com/path"
      );
    });
  });

  describe("invalid URLs", () => {
    it("returns invalid URLs as-is", () => {
      expect(normalizeUrl("not a url")).toBe("not a url");
    });

    it("returns bare hostnames as-is", () => {
      expect(normalizeUrl("example.com")).toBe("example.com");
    });

    it("returns empty strings as-is", () => {
      expect(normalizeUrl("")).toBe("");
    });

    it("returns relative paths as-is", () => {
      expect(normalizeUrl("/path/to/page#section")).toBe("/path/to/page#section");
    });
  });

  describe("edge cases", () => {
    it("handles URLs with multiple hash symbols in fragment", () => {
      // Only the first # starts the fragment
      expect(normalizeUrl("https://example.com/page#section#subsection")).toBe(
        "https://example.com/page"
      );
    });

    it("handles localhost URLs", () => {
      expect(normalizeUrl("http://localhost:3000/test#anchor")).toBe("http://localhost:3000/test");
    });

    it("handles IPv4 address URLs", () => {
      expect(normalizeUrl("http://192.168.1.1/page#top")).toBe("http://192.168.1.1/page");
    });

    it("handles IPv6 address URLs", () => {
      expect(normalizeUrl("http://[::1]/page#section")).toBe("http://[::1]/page");
    });
  });
});
