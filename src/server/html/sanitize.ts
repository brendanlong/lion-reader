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

import { createHash } from "node:crypto";

import {
  sanitizeEntryHtml as nativeSanitizeEntryHtml,
  sanitizeEntryHtmlAsync as nativeSanitizeEntryHtmlAsync,
} from "@lion-reader/sanitizer";

import { logger } from "@/lib/logger";
import { startSanitizeTimer } from "@/server/metrics/metrics";

function logWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    logger.warn("Sanitizer warning", { warning });
  }
}

/**
 * Handles a *fatal* sanitizer failure — the native module threw instead of
 * returning output.
 *
 * The native pipeline is written to fail closed: the allow-list pass builds its
 * output into a local buffer and a rewriter error (or a caught panic)
 * propagates as `Err`, so a thrown error carries **no** partial or unsanitized
 * HTML — there is nothing to serve but nothing. This wrapper therefore turns
 * the throw into the same `null` it already returns for empty input, which
 * every caller treats as "this entry has no body" (either a nullable content
 * column rendered as the empty state, or `?? ""`). Without it, one such entry
 * is a permanent HTTP 500 for `entries.get` and takes a whole ~100-entry Google
 * Reader `stream-contents` batch down with it.
 *
 * The known trigger is lol_html's parsing-ambiguity guard: a text-content start
 * tag (`<style>`, `<title>`, `<xmp>`, `<iframe>`, `<noembed>`) while a
 * `<select>` is open is genuinely ambiguous to a streaming rewriter, so it
 * refuses to guess rather than risk the `<select><xmp><script>` mXSS gadget.
 * That guard is load-bearing — do not disable it to make this case "work".
 *
 * The log line carries a SHA-256 of the input rather than the input itself:
 * entry bodies are untrusted and can be private (saved articles), and the hash
 * is enough to find the row, since the raw content is what we store —
 * `encode(sha256(content_original::bytea), 'hex')` matches it.
 */
function sanitizeFailedClosed(html: string, error: unknown): null {
  logger.error("Sanitizer failed; serving empty content", {
    error: error instanceof Error ? error.message : String(error),
    htmlLength: html.length,
    htmlSha256: createHash("sha256").update(html, "utf8").digest("hex"),
  });
  return null;
}

/**
 * Sanitizes untrusted entry HTML for safe rendering in the browser.
 *
 * Returns `null` for `null`/empty input so callers can pass through nullable
 * content fields unchanged, and — see {@link sanitizeFailedClosed} — for a
 * fatal sanitizer failure, so one unsanitizable body can't 500 the request
 * that reads it. Synchronous — fine off the request path
 * (background jobs) and for small bodies; app-server request paths should
 * prefer {@link sanitizeEntryHtmlAsync} for large bodies.
 */
export function sanitizeEntryHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  const stopTimer = startSanitizeTimer();
  try {
    const result = nativeSanitizeEntryHtml(html);
    logWarnings(result.warnings);
    return result.html;
  } catch (error) {
    return sanitizeFailedClosed(html, error);
  } finally {
    stopTimer();
  }
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
  // Small bodies run through the sync path, which records its own timing.
  if (html.length <= SANITIZE_INLINE_MAX_CHARS) {
    return sanitizeEntryHtml(html);
  }
  const stopTimer = startSanitizeTimer();
  try {
    const result = await nativeSanitizeEntryHtmlAsync(html);
    logWarnings(result.warnings);
    return result.html;
  } catch (error) {
    return sanitizeFailedClosed(html, error);
  } finally {
    stopTimer();
  }
}
