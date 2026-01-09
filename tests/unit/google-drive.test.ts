/**
 * Unit tests for Google Drive content fetching utilities.
 */

import { describe, it, expect } from "vitest";
import { cleanTitle } from "../../src/server/google/drive";

describe("Google Drive utilities", () => {
  describe("cleanTitle", () => {
    it("removes .docx extension", () => {
      expect(cleanTitle("Ethereal Spring Part One.docx")).toBe("Ethereal Spring Part One");
    });

    it("removes .doc extension", () => {
      expect(cleanTitle("My Document.doc")).toBe("My Document");
    });

    it("handles case-insensitive extensions", () => {
      expect(cleanTitle("Document.DOCX")).toBe("Document");
      expect(cleanTitle("Document.Docx")).toBe("Document");
    });

    it("removes other common document extensions", () => {
      expect(cleanTitle("Document.pdf")).toBe("Document");
      expect(cleanTitle("Document.odt")).toBe("Document");
      expect(cleanTitle("Document.rtf")).toBe("Document");
      expect(cleanTitle("Document.txt")).toBe("Document");
    });

    it("preserves titles without extensions or suffixes", () => {
      expect(cleanTitle("My Document")).toBe("My Document");
      expect(cleanTitle("Ethereal Spring Part One")).toBe("Ethereal Spring Part One");
    });

    it("trims whitespace", () => {
      expect(cleanTitle("  My Document  ")).toBe("My Document");
      expect(cleanTitle("Document.docx  ")).toBe("Document");
    });

    it("handles empty strings", () => {
      expect(cleanTitle("")).toBe("");
    });

    it("handles titles that look like extensions but aren't at the end", () => {
      expect(cleanTitle("My.docx.backup")).toBe("My.docx.backup");
      expect(cleanTitle("file.doc.old")).toBe("file.doc.old");
    });
  });
});
