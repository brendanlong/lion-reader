/**
 * Unit tests for the piscina worker-thread task dispatcher (`handleTask`).
 *
 * Calling `handleTask` directly (no thread spawned) deterministically covers
 * the task logic that runs inside the pool: the fused-sanitize option on
 * `cleanContent` and the sanitizer-version probe. (Standalone sanitization no
 * longer goes through the pool — the native sanitizer runs it on the libuv
 * thread pool; see sanitizeEntryHtmlInWorker.)
 */

import { describe, it, expect } from "vitest";
import handleTask from "@/server/worker-thread/worker";
import { sanitizeEntryHtml, SANITIZER_VERSION } from "@/server/html/sanitize";
import type { CleanedContent } from "@/server/worker-thread/types";

const READABLE_ARTICLE =
  "<html><body><article><h1>Sample Title</h1>" +
  "<p>Body paragraph with enough words to be considered readable content by Readability.</p>".repeat(
    12
  ) +
  '<script>alert("xss")</script></article></body></html>';

describe("worker-thread handleTask", () => {
  describe("cleanContent task fused sanitize", () => {
    it("returns contentSanitized === sanitizeEntryHtml(content) when sanitizeCleaned is set", () => {
      const result = handleTask({
        type: "cleanContent",
        html: READABLE_ARTICLE,
        sanitizeCleaned: true,
      }) as CleanedContent | null;

      expect(result).not.toBeNull();
      expect(result!.contentSanitized).toBe(sanitizeEntryHtml(result!.content));
      expect(result!.contentSanitized).not.toContain("<script>");
    });

    it("omits contentSanitized when sanitizeCleaned is not requested", () => {
      const result = handleTask({
        type: "cleanContent",
        html: READABLE_ARTICLE,
      }) as CleanedContent | null;

      expect(result).not.toBeNull();
      expect(result!.contentSanitized).toBeUndefined();
    });
  });

  describe("sanitizerVersion probe", () => {
    it("reports the same version as the main process (shared native module)", () => {
      const result = handleTask({ type: "sanitizerVersion" }) as { version: number };
      expect(result.version).toBe(SANITIZER_VERSION);
    });
  });
});
