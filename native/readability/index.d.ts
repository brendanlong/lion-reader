/**
 * Hand-maintained typings for the native readability extractor (see
 * src/lib.rs). Keep in lockstep with the #[napi] exports.
 */

export interface ExtractOptions {
  /** Keep all classes on extracted elements (Mozilla `keepClasses`). */
  keepClasses?: boolean;
  /** Character threshold for content detection (Mozilla `charThreshold`). */
  charThreshold?: number;
}

export interface ExtractedArticle {
  /** The extracted article HTML. */
  content: string;
  /** Plain text of the extracted article. */
  textContent: string;
  /** Article excerpt/description, when one was found (key absent otherwise). */
  excerpt?: string;
  /** Extracted title ("" when none was found, matching readability.js). */
  title: string;
  /** Author byline, when one was found (key absent otherwise). */
  byline?: string;
  /**
   * Result of the fast is-probably-readable heuristic (informational —
   * extraction ran regardless, matching the old cleanContent behavior).
   */
  probablyReadable: boolean;
}

/**
 * Extracts the main article content from HTML (dom_smoothie, a Rust port of
 * Mozilla Readability). Returns null when no main content could be
 * identified. Synchronous; blocks the calling thread (~3ms per 200KB).
 */
export function extractArticle(
  html: string,
  options?: ExtractOptions | null
): ExtractedArticle | null;

/**
 * Async form of `extractArticle`: runs on the libuv thread pool so large
 * pages never block the event loop.
 */
export function extractArticleAsync(
  html: string,
  options?: ExtractOptions | null
): Promise<ExtractedArticle | null>;
