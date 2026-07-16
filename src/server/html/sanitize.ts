/**
 * Server-side HTML sanitization for entry content.
 *
 * Entry bodies come from untrusted feeds and are rendered in the browser via
 * `dangerouslySetInnerHTML`, so they must be sanitized before they reach the
 * client. The sanitizer itself is a native Rust module
 * (`@lion-reader/sanitizer`, see `native/sanitizer/`) that runs the whole
 * pipeline behind one N-API call:
 *
 *  1. MathJax CHTML → MathML conversion (equations survive sanitization;
 *     degrades to "math stripped" on error),
 *  2. inline-SVG extraction + sanitization against a DOMPurify-derived
 *     allow-list (degrades to "SVG stripped" on error),
 *  3. the HTML allow-list pass on lol_html — a spec-conformant streaming
 *     HTML5 tokenizer, so the markup is tokenized exactly the way a browser
 *     will tokenize the output (no parser-differential class of bypasses),
 *  4. SVG re-insertion.
 *
 * The allow-lists and transforms live in `native/sanitizer/core/src/` —
 * `sanitize.rs` (tags/attributes/schemes, link/img/iframe transforms),
 * `embeds.rs` (iframe embed providers), `mathjax.rs`, `svg.rs`. This module
 * is a thin wrapper that keeps the nullable-content signature and logs the
 * native module's non-fatal warnings (e.g. the MathJax layout-drift canary).
 *
 * The client renders trusted HTML and ships no sanitizer — do not
 * reintroduce one.
 */

import {
  sanitizeEntryHtml as nativeSanitizeEntryHtml,
  sanitizeEntryHtmlAsync as nativeSanitizeEntryHtmlAsync,
  SANITIZER_VERSION as NATIVE_SANITIZER_VERSION,
} from "@lion-reader/sanitizer";

import { logger } from "@/lib/logger";

/**
 * Version of the sanitization rules, re-exported from the native module —
 * the compiled rules are the single source of truth, so TypeScript can never
 * disagree with the binary about what version is running. Bump it in
 * `native/sanitizer/core/src/lib.rs` whenever sanitizer behavior changes
 * (allow-lists, transforms, serialization).
 *
 * Sanitized entry HTML is persisted in the database (`entries.*_sanitized`,
 * stamped with `*_sanitized_version`; see `withSanitizedEntryContent` in
 * `sanitize-entry.ts`). The read path (`resolveSanitizedContent` in the entries
 * router) compares the stored version against this constant and re-sanitizes
 * from the raw columns when they differ — so bumping this value marks every row
 * stale and transparently re-sanitizes it on next read instead of serving stale
 * output.
 */
export const SANITIZER_VERSION: number = NATIVE_SANITIZER_VERSION;

function logWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    logger.warn("Sanitizer warning", { warning });
  }
}

/**
 * Sanitizes untrusted entry HTML for safe rendering in the browser.
 *
 * Returns `null` for `null`/empty input so callers can pass through nullable
 * content fields unchanged. Synchronous — fine off the request path
 * (background jobs) and for small bodies; app-server request paths should
 * prefer {@link sanitizeEntryHtmlAsync} for large bodies.
 */
export function sanitizeEntryHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const result = nativeSanitizeEntryHtml(html);
  logWarnings(result.warnings);
  return result.html;
}

/**
 * Bodies at or below this size are sanitized synchronously on the calling
 * thread: the native sanitizer runs in well under a millisecond for them, so
 * the fixed cost of scheduling a libuv-thread-pool task (and copying the
 * string across the N-API boundary twice) isn't worth paying. ~10 KB.
 */
const SANITIZE_INLINE_MAX_CHARS = 10 * 1024;

/**
 * Async form of {@link sanitizeEntryHtml}: the native pipeline runs on the
 * libuv thread pool for bodies above the inline threshold, so a large body
 * never blocks the event loop that serves UI requests; small bodies run
 * synchronously, which is cheaper than scheduling a task.
 *
 * Intended for app-server request paths (saved articles, on-demand
 * full-content fetch, read-path re-sanitize). Background jobs (feed
 * fetching, email ingest) deliberately use the synchronous
 * {@link sanitizeEntryHtml} — they already run off the request path, so the
 * async hop would be pure overhead.
 */
export async function sanitizeEntryHtmlAsync(
  html: string | null | undefined
): Promise<string | null> {
  if (!html) return null;
  if (html.length <= SANITIZE_INLINE_MAX_CHARS) {
    return sanitizeEntryHtml(html);
  }
  const result = await nativeSanitizeEntryHtmlAsync(html);
  logWarnings(result.warnings);
  return result.html;
}
