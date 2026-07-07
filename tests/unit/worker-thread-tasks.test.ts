/**
 * Unit tests for the piscina worker-thread task dispatcher (`handleTask`).
 *
 * Calling `handleTask` directly (no thread spawned) deterministically covers the
 * task logic that runs inside the pool: the `sanitizeEntryHtml` offload task and
 * the fused-sanitize option on `cleanContent`. The pool wrapper
 * (`sanitizeEntryHtmlInWorker`) only forwards these results, so proving the task
 * output equals the inline `sanitizeEntryHtml` here is what guarantees the
 * offloaded path can't diverge from the synchronous one.
 */

import { describe, it, expect } from "vitest";
import handleTask from "@/server/worker-thread/worker";
import { sanitizeEntryHtml } from "@/server/html/sanitize";
import type { CleanedContent } from "@/server/worker-thread/types";

const READABLE_ARTICLE =
  "<html><body><article><h1>Sample Title</h1>" +
  "<p>Body paragraph with enough words to be considered readable content by Readability.</p>".repeat(
    12
  ) +
  '<script>alert("xss")</script></article></body></html>';

describe("worker-thread handleTask", () => {
  describe("sanitizeEntryHtml task", () => {
    it("produces exactly the same output as the inline sanitizeEntryHtml", () => {
      const html =
        '<p onclick="evil()">hi<script>alert(1)</script></p><a href="https://x.com">x</a>';
      const result = handleTask({ type: "sanitizeEntryHtml", html }) as {
        sanitized: string | null;
      };
      expect(result.sanitized).toBe(sanitizeEntryHtml(html));
      expect(result.sanitized).not.toContain("<script>");
      expect(result.sanitized).not.toContain("onclick");
    });

    it("returns null for empty input (matching sanitizeEntryHtml)", () => {
      const result = handleTask({ type: "sanitizeEntryHtml", html: "" }) as {
        sanitized: string | null;
      };
      expect(result.sanitized).toBeNull();
    });
  });

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
});
