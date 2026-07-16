/**
 * Unit tests for `cleanContentSanitizedAsync`: native extraction on the libuv
 * pool composed with a sanitize of the cleaned output, so write paths can
 * persist the cleaned HTML without sanitizing it again. The `contentSanitized`
 * value MUST equal `sanitizeEntryHtml(content)` — it's handed to
 * `withSanitizedEntryContentAsync` as a `presanitized` hint.
 */

import { describe, it, expect } from "vitest";
import { cleanContentAsync, cleanContentSanitizedAsync } from "@/server/feed/content-cleaner";
import { sanitizeEntryHtml } from "@/server/html/sanitize";

const READABLE_ARTICLE =
  "<html><body><article><h1>Sample Title</h1>" +
  "<p>Body paragraph with enough words to be considered readable content by Readability.</p>".repeat(
    12
  ) +
  '<script>alert("xss")</script></article></body></html>';

describe("cleanContentSanitizedAsync", () => {
  it("returns contentSanitized === sanitizeEntryHtml(content)", async () => {
    const result = await cleanContentSanitizedAsync(READABLE_ARTICLE);

    expect(result).not.toBeNull();
    expect(result!.contentSanitized).toBe(sanitizeEntryHtml(result!.content));
    expect(result!.contentSanitized).not.toContain("<script>");
  });

  it("matches plain cleanContentAsync apart from the sanitized field", async () => {
    const sanitized = await cleanContentSanitizedAsync(READABLE_ARTICLE);
    const plain = await cleanContentAsync(READABLE_ARTICLE);

    expect(sanitized).not.toBeNull();
    expect(plain).not.toBeNull();
    const rest = { ...sanitized! };
    delete (rest as { contentSanitized?: string | null }).contentSanitized;
    expect(rest).toEqual(plain);
  });

  it("returns null when extraction produces nothing", async () => {
    expect(await cleanContentSanitizedAsync("<p>too short</p>")).toBeNull();
  });
});
