/**
 * Unit tests for HTTP Link header parsing for WebSub discovery.
 */

import { describe, it, expect } from "vitest";
import { parseWebSubLinkHeaders } from "../../src/server/feed/link-header";

describe("parseWebSubLinkHeaders", () => {
  describe("hub URL extraction", () => {
    it("extracts hub URL from Link header with quoted rel", () => {
      const result = parseWebSubLinkHeaders('<https://hub.example.com/>; rel="hub"');

      expect(result.hubUrl).toBe("https://hub.example.com/");
    });

    it("extracts hub URL from Link header with unquoted rel", () => {
      const result = parseWebSubLinkHeaders("<https://hub.example.com/>; rel=hub");

      expect(result.hubUrl).toBe("https://hub.example.com/");
    });

    it("extracts hub URL case-insensitively for rel parameter name", () => {
      const result = parseWebSubLinkHeaders('<https://hub.example.com/>; REL="hub"');

      expect(result.hubUrl).toBe("https://hub.example.com/");
    });
  });

  describe("self URL extraction", () => {
    it("extracts self URL from Link header", () => {
      const result = parseWebSubLinkHeaders('<https://example.com/feed.xml>; rel="self"');

      expect(result.selfUrl).toBe("https://example.com/feed.xml");
    });

    it("extracts self URL with unquoted rel", () => {
      const result = parseWebSubLinkHeaders("<https://example.com/feed.xml>; rel=self");

      expect(result.selfUrl).toBe("https://example.com/feed.xml");
    });
  });

  describe("multiple links", () => {
    it("extracts both hub and self from comma-separated Link header", () => {
      const result = parseWebSubLinkHeaders(
        '<https://hub.example.com/>; rel="hub", <https://example.com/feed.xml>; rel="self"'
      );

      expect(result.hubUrl).toBe("https://hub.example.com/");
      expect(result.selfUrl).toBe("https://example.com/feed.xml");
    });

    it("ignores non-websub link relations", () => {
      const result = parseWebSubLinkHeaders(
        '<https://hub.example.com/>; rel="hub", <https://example.com/style.css>; rel="stylesheet", <https://example.com/feed.xml>; rel="self"'
      );

      expect(result.hubUrl).toBe("https://hub.example.com/");
      expect(result.selfUrl).toBe("https://example.com/feed.xml");
    });

    it("uses the last hub URL when multiple are present", () => {
      const result = parseWebSubLinkHeaders(
        '<https://hub1.example.com/>; rel="hub", <https://hub2.example.com/>; rel="hub"'
      );

      expect(result.hubUrl).toBe("https://hub2.example.com/");
    });
  });

  describe("edge cases", () => {
    it("returns empty object for empty string", () => {
      const result = parseWebSubLinkHeaders("");

      expect(result.hubUrl).toBeUndefined();
      expect(result.selfUrl).toBeUndefined();
    });

    it("returns empty object for header with no recognizable links", () => {
      const result = parseWebSubLinkHeaders("not a valid link header");

      expect(result.hubUrl).toBeUndefined();
      expect(result.selfUrl).toBeUndefined();
    });

    it("handles extra whitespace", () => {
      const result = parseWebSubLinkHeaders(
        '  <https://hub.example.com/>  ;  rel="hub"  ,  <https://example.com/feed.xml>  ;  rel="self"  '
      );

      expect(result.hubUrl).toBe("https://hub.example.com/");
      expect(result.selfUrl).toBe("https://example.com/feed.xml");
    });

    it("handles URLs with commas inside angle brackets", () => {
      const result = parseWebSubLinkHeaders('<https://hub.example.com/path?a=1,b=2>; rel="hub"');

      expect(result.hubUrl).toBe("https://hub.example.com/path?a=1,b=2");
    });

    it("handles Link header with additional parameters", () => {
      const result = parseWebSubLinkHeaders(
        '<https://hub.example.com/>; rel="hub"; type="application/atom+xml"'
      );

      expect(result.hubUrl).toBe("https://hub.example.com/");
    });

    it("skips links without a URL in angle brackets", () => {
      const result = parseWebSubLinkHeaders('https://hub.example.com/; rel="hub"');

      expect(result.hubUrl).toBeUndefined();
    });

    it("skips links without a rel parameter", () => {
      const result = parseWebSubLinkHeaders("<https://hub.example.com/>");

      expect(result.hubUrl).toBeUndefined();
    });
  });
});
