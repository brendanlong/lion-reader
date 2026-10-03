/**
 * Unit tests for URL utilities. normalizeUrl is covered in frontend/url.test.ts.
 */

import { describe, it, expect } from "vitest";
import { safeDecodeURIComponent } from "../../src/lib/url";

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
