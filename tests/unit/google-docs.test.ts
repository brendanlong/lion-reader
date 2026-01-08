/**
 * Unit tests for Google Docs URL detection and document ID extraction.
 *
 * These test the pure functions that determine if a URL is from Google Docs
 * and extract the document ID for Google Docs API calls.
 */

import { describe, it, expect } from "vitest";
import { isGoogleDocsUrl, extractDocId } from "../../src/server/google/docs";

describe("Google Docs URL detection", () => {
  describe("isGoogleDocsUrl", () => {
    it("returns true for standard Google Docs URLs with /edit", () => {
      expect(isGoogleDocsUrl("https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/edit")).toBe(
        true
      );
      expect(
        isGoogleDocsUrl(
          "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit"
        )
      ).toBe(true);
    });

    it("returns true for Google Docs URLs with /edit and hash fragment", () => {
      expect(
        isGoogleDocsUrl(
          "https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/edit#heading=h.abc123"
        )
      ).toBe(true);
      expect(
        isGoogleDocsUrl(
          "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0"
        )
      ).toBe(true);
    });

    it("returns true for Google Docs URLs with /edit and query parameters", () => {
      expect(
        isGoogleDocsUrl("https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/edit?usp=sharing")
      ).toBe(true);
      expect(
        isGoogleDocsUrl(
          "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?pli=1"
        )
      ).toBe(true);
    });

    it("returns true for Google Docs URLs with /pub (published view)", () => {
      expect(isGoogleDocsUrl("https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/pub")).toBe(
        true
      );
      expect(
        isGoogleDocsUrl(
          "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/pub?embedded=true"
        )
      ).toBe(true);
    });

    it("returns true for Google Docs URLs with /preview", () => {
      expect(
        isGoogleDocsUrl("https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/preview")
      ).toBe(true);
      expect(
        isGoogleDocsUrl(
          "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/preview"
        )
      ).toBe(true);
    });

    it("returns true for Google Docs URLs without trailing path", () => {
      expect(isGoogleDocsUrl("https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/")).toBe(
        true
      );
      expect(isGoogleDocsUrl("https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j")).toBe(true);
    });

    it("returns true for HTTP URLs (not just HTTPS)", () => {
      expect(isGoogleDocsUrl("http://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/edit")).toBe(
        true
      );
    });

    it("returns true for document IDs with hyphens and underscores", () => {
      expect(isGoogleDocsUrl("https://docs.google.com/document/d/1abc-def_ghi-123/edit")).toBe(
        true
      );
      expect(isGoogleDocsUrl("https://docs.google.com/document/d/abc_123-xyz_789/edit")).toBe(true);
    });

    it("returns false for Google Sheets URLs", () => {
      expect(
        isGoogleDocsUrl("https://docs.google.com/spreadsheets/d/1a2b3c4d5e6f7g8h9i0j/edit")
      ).toBe(false);
    });

    it("returns false for Google Slides URLs", () => {
      expect(
        isGoogleDocsUrl("https://docs.google.com/presentation/d/1a2b3c4d5e6f7g8h9i0j/edit")
      ).toBe(false);
    });

    it("returns false for Google Forms URLs", () => {
      expect(isGoogleDocsUrl("https://docs.google.com/forms/d/1a2b3c4d5e6f7g8h9i0j/edit")).toBe(
        false
      );
    });

    it("returns false for Google Drive URLs", () => {
      expect(isGoogleDocsUrl("https://drive.google.com/file/d/1a2b3c4d5e6f7g8h9i0j/view")).toBe(
        false
      );
    });

    it("returns false for non-Google URLs", () => {
      expect(isGoogleDocsUrl("https://example.com/document")).toBe(false);
      expect(isGoogleDocsUrl("https://microsoft.com/word/document")).toBe(false);
    });

    it("returns false for Google Docs homepage", () => {
      expect(isGoogleDocsUrl("https://docs.google.com")).toBe(false);
      expect(isGoogleDocsUrl("https://docs.google.com/document")).toBe(false);
      expect(isGoogleDocsUrl("https://docs.google.com/document/")).toBe(false);
    });

    it("returns false for invalid URLs", () => {
      expect(isGoogleDocsUrl("not a url")).toBe(false);
      expect(isGoogleDocsUrl("")).toBe(false);
      expect(isGoogleDocsUrl("docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/edit")).toBe(false);
    });
  });

  describe("extractDocId", () => {
    it("extracts document ID from standard Google Docs URLs", () => {
      expect(extractDocId("https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/edit")).toBe(
        "1a2b3c4d5e6f7g8h9i0j"
      );
      expect(
        extractDocId(
          "https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit"
        )
      ).toBe("1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms");
    });

    it("extracts document ID from URLs with /pub", () => {
      expect(extractDocId("https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/pub")).toBe(
        "1a2b3c4d5e6f7g8h9i0j"
      );
    });

    it("extracts document ID from URLs with /preview", () => {
      expect(extractDocId("https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/preview")).toBe(
        "1a2b3c4d5e6f7g8h9i0j"
      );
    });

    it("extracts document ID from URLs without trailing path", () => {
      expect(extractDocId("https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/")).toBe(
        "1a2b3c4d5e6f7g8h9i0j"
      );
      expect(extractDocId("https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j")).toBe(
        "1a2b3c4d5e6f7g8h9i0j"
      );
    });

    it("extracts document ID from URLs with query parameters", () => {
      expect(
        extractDocId("https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/edit?usp=sharing")
      ).toBe("1a2b3c4d5e6f7g8h9i0j");
    });

    it("extracts document ID from URLs with hash fragments", () => {
      expect(
        extractDocId(
          "https://docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/edit#heading=h.abc123"
        )
      ).toBe("1a2b3c4d5e6f7g8h9i0j");
    });

    it("extracts document IDs with hyphens and underscores", () => {
      expect(extractDocId("https://docs.google.com/document/d/abc-123_xyz/edit")).toBe(
        "abc-123_xyz"
      );
      expect(extractDocId("https://docs.google.com/document/d/1abc-def_ghi-123_xyz/edit")).toBe(
        "1abc-def_ghi-123_xyz"
      );
    });

    it("returns null for non-Google Docs URLs", () => {
      expect(extractDocId("https://example.com/document")).toBe(null);
      expect(extractDocId("https://docs.google.com/spreadsheets/d/1a2b3c4d5e6f7g8h9i0j/edit")).toBe(
        null
      );
    });

    it("returns null for Google Docs homepage URLs", () => {
      expect(extractDocId("https://docs.google.com")).toBe(null);
      expect(extractDocId("https://docs.google.com/document")).toBe(null);
      expect(extractDocId("https://docs.google.com/document/")).toBe(null);
    });

    it("returns null for invalid URLs", () => {
      expect(extractDocId("not a url")).toBe(null);
      expect(extractDocId("")).toBe(null);
      expect(extractDocId("docs.google.com/document/d/1a2b3c4d5e6f7g8h9i0j/edit")).toBe(null);
    });
  });
});
