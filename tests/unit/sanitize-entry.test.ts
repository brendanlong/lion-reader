/**
 * Unit tests for the single entry write-path sanitization helper.
 *
 * `withSanitizedEntryContent` is the one place that derives the `*_sanitized`
 * columns from raw content, so every entry write stays consistent. These tests
 * pin that invariant: which families it stamps, and that it actually sanitizes.
 */

import { describe, it, expect } from "vitest";
import { withSanitizedEntryContent } from "../../src/server/html/sanitize-entry";
import { SANITIZER_VERSION } from "../../src/server/html/sanitize";

describe("withSanitizedEntryContent", () => {
  it("derives sanitized columns + version for the content family", () => {
    const result = withSanitizedEntryContent({
      contentOriginal: '<p onclick="evil()">hi<script>alert(1)</script></p>',
      contentCleaned: "<p>clean</p>",
    });

    expect(result.contentSanitizedVersion).toBe(SANITIZER_VERSION);
    expect(result.contentOriginalSanitized).not.toContain("<script>");
    expect(result.contentOriginalSanitized).not.toContain("onclick");
    expect(result.contentCleanedSanitized).toBe("<p>clean</p>");
    // Full-content family was not written, so it isn't stamped.
    expect(result.fullContentSanitizedVersion).toBeUndefined();
    expect("fullContentOriginalSanitized" in result).toBe(false);
  });

  it("derives sanitized columns + version for the full-content family", () => {
    const result = withSanitizedEntryContent({
      fullContentOriginal: "<article><script>x</script>body</article>",
      fullContentCleaned: null,
    });

    expect(result.fullContentSanitizedVersion).toBe(SANITIZER_VERSION);
    // No cleaned content, so original is the serving variant and IS sanitized.
    expect(result.fullContentOriginalSanitized).toContain("body");
    expect(result.fullContentOriginalSanitized).not.toContain("<script>");
    expect(result.fullContentCleanedSanitized).toBeNull();
    // Content family was not written, so it isn't stamped.
    expect(result.contentSanitizedVersion).toBeUndefined();
    expect("contentOriginalSanitized" in result).toBe(false);
  });

  it("does NOT materialize full-content original when cleaned exists (lazy rule)", () => {
    // The full-content serving rule is strictly `cleaned ?? original`, so when
    // cleaned exists the whole-page original must not be sanitized/persisted —
    // its sanitized column is NULL at the current version (issue #1117).
    const result = withSanitizedEntryContent({
      fullContentOriginal: "<article><script>x</script>whole raw page</article>",
      fullContentCleaned: "<p>cleaned<script>y</script></p>",
    });

    expect(result.fullContentSanitizedVersion).toBe(SANITIZER_VERSION);
    expect(result.fullContentOriginalSanitized).toBeNull();
    expect(result.fullContentCleanedSanitized).toContain("cleaned");
    expect(result.fullContentCleanedSanitized).not.toContain("<script>");
  });

  it("stamps both families when both are written", () => {
    const result = withSanitizedEntryContent({
      contentOriginal: "<p>a</p>",
      contentCleaned: "<p>b</p>",
      fullContentOriginal: "<p>c</p>",
      fullContentCleaned: "<p>d</p>",
    });

    expect(result.contentSanitizedVersion).toBe(SANITIZER_VERSION);
    expect(result.fullContentSanitizedVersion).toBe(SANITIZER_VERSION);
    // The content family always materializes BOTH variants (the frontend has a
    // user-facing original/cleaned toggle for feed content); only the
    // full-content original is lazy.
    expect(result.contentOriginalSanitized).toBe("<p>a</p>");
    expect(result.contentCleanedSanitized).toBe("<p>b</p>");
    expect(result.fullContentOriginalSanitized).toBeNull();
    expect(result.fullContentCleanedSanitized).toBe("<p>d</p>");
  });

  it("preserves the other fields it is given (passthrough)", () => {
    // Real callers pass large typed insert/update objects; mirror that with a
    // variable so the generic sees fields beyond the content family.
    const input = {
      id: "abc",
      type: "saved" as const,
      contentOriginal: "<p>x</p>",
      contentCleaned: null,
    };
    const result = withSanitizedEntryContent(input);

    expect(result.id).toBe("abc");
    expect(result.type).toBe("saved");
    expect(result.contentCleanedSanitized).toBeNull();
  });
});
