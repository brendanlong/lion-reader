/**
 * Unit tests for the worker-thread offload surface: `cleanContentInWorker`
 * (native extraction on the libuv pool + optional sanitize of the cleaned
 * output — no piscina involved anymore) and the piscina task dispatcher
 * (`handleTask`), which now only serves parseFeed and the sanitizer-version
 * probe. (Standalone sanitization also doesn't go through the pool — the
 * native sanitizer runs it on the libuv thread pool; see
 * sanitizeEntryHtmlInWorker.)
 */

import { describe, it, expect } from "vitest";
import handleTask from "@/server/worker-thread/worker";
import { cleanContentInWorker } from "@/server/worker-thread/pool";
import { sanitizeEntryHtml, SANITIZER_VERSION } from "@/server/html/sanitize";

const READABLE_ARTICLE =
  "<html><body><article><h1>Sample Title</h1>" +
  "<p>Body paragraph with enough words to be considered readable content by Readability.</p>".repeat(
    12
  ) +
  '<script>alert("xss")</script></article></body></html>';

describe("cleanContentInWorker", () => {
  it("returns contentSanitized === sanitizeEntryHtml(content) when sanitizeCleaned is set", async () => {
    const result = await cleanContentInWorker(READABLE_ARTICLE, undefined, {
      sanitizeCleaned: true,
    });

    expect(result).not.toBeNull();
    expect(result!.contentSanitized).toBe(sanitizeEntryHtml(result!.content));
    expect(result!.contentSanitized).not.toContain("<script>");
  });

  it("omits contentSanitized when sanitizeCleaned is not requested", async () => {
    const result = await cleanContentInWorker(READABLE_ARTICLE);

    expect(result).not.toBeNull();
    expect(result!.contentSanitized).toBeUndefined();
  });
});

describe("worker-thread handleTask", () => {
  describe("sanitizerVersion probe", () => {
    it("reports the same version as the main process (shared native module)", () => {
      const result = handleTask({ type: "sanitizerVersion" }) as { version: number };
      expect(result.version).toBe(SANITIZER_VERSION);
    });
  });
});
