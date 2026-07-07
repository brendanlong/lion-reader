/**
 * Unit tests for the worker-offloading write-path sanitizer helpers.
 *
 * These assert that the async, worker-offloading path produces byte-identical
 * output to the synchronous chokepoint (`withSanitizedEntryContent`), so moving
 * sanitization off the event loop can never change what gets stored, and that
 * the `presanitized` reuse hook is honored.
 *
 * All inputs are small (< the 10 KB inline threshold), so these run on the
 * inline fallback path and never spawn a worker thread — the offloaded path is
 * proven equivalent by tests/unit/worker-thread-tasks.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  withSanitizedEntryContent,
  withSanitizedEntryContentAsync,
} from "@/server/html/sanitize-entry";
import { sanitizeEntryHtml } from "@/server/html/sanitize";
import { sanitizeEntryHtmlInWorker } from "@/server/worker-thread/pool";

const UNSAFE = '<p onclick="evil()">hi<script>alert(1)</script></p>';

describe("withSanitizedEntryContentAsync", () => {
  it("matches the sync helper for the content family", async () => {
    const values = { contentOriginal: UNSAFE, contentCleaned: "<p>clean</p>" };
    const async = await withSanitizedEntryContentAsync({ ...values });
    const sync = withSanitizedEntryContent({ ...values });
    expect(async).toEqual(sync);
  });

  it("matches the sync helper for the full-content family", async () => {
    const values = { fullContentOriginal: UNSAFE, fullContentCleaned: null };
    const async = await withSanitizedEntryContentAsync({ ...values });
    const sync = withSanitizedEntryContent({ ...values });
    expect(async).toEqual(sync);
  });

  it("stamps only the families whose raw fields are present", async () => {
    const result = await withSanitizedEntryContentAsync({ contentOriginal: "<p>a</p>" });
    expect("contentOriginalSanitized" in result).toBe(true);
    expect("fullContentOriginalSanitized" in result).toBe(false);
    expect(result.fullContentSanitizedVersion).toBeUndefined();
  });

  it("reuses a supplied presanitized value instead of re-sanitizing", async () => {
    // A caller-supplied value is used verbatim (the caller guarantees it equals
    // sanitizeEntryHtml of the raw field). A sentinel proves reuse rather than
    // re-sanitization.
    const result = await withSanitizedEntryContentAsync(
      { contentOriginal: UNSAFE, contentCleaned: "<p>cleaned</p>" },
      { contentCleanedSanitized: "SENTINEL" }
    );
    expect(result.contentCleanedSanitized).toBe("SENTINEL");
    // The un-hinted field is still sanitized normally.
    expect(result.contentOriginalSanitized).toBe(sanitizeEntryHtml(UNSAFE));
  });

  it("sanitizes normally when the presanitized hint omits the field", async () => {
    const result = await withSanitizedEntryContentAsync(
      { contentCleaned: "<p>cleaned</p>" },
      {} // no hint
    );
    expect(result.contentCleanedSanitized).toBe(sanitizeEntryHtml("<p>cleaned</p>"));
  });
});

describe("sanitizeEntryHtmlInWorker", () => {
  it("returns null for nullish/empty input", async () => {
    expect(await sanitizeEntryHtmlInWorker(null)).toBeNull();
    expect(await sanitizeEntryHtmlInWorker(undefined)).toBeNull();
    expect(await sanitizeEntryHtmlInWorker("")).toBeNull();
  });

  it("matches sanitizeEntryHtml for small inputs (inline path)", async () => {
    expect(await sanitizeEntryHtmlInWorker(UNSAFE)).toBe(sanitizeEntryHtml(UNSAFE));
  });
});
