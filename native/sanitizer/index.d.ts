/**
 * Hand-maintained typings for the native sanitizer (see src/lib.rs).
 * Keep in lockstep with the #[napi] exports.
 */

export interface SanitizeOutput {
  html: string;
  /**
   * Non-fatal diagnostics (e.g. unrecognized MathJax wrappers — the canary
   * for MathJax layout drift) for the caller to log.
   */
  warnings: string[];
}

/**
 * Sanitizes untrusted entry HTML for safe rendering in the browser.
 * Runs the full pipeline: MathJax CHTML->MathML conversion, inline-SVG
 * sanitization, and the HTML allow-list pass. Synchronous; blocks the
 * calling thread for the duration (~1ms per 100KB).
 */
export function sanitizeEntryHtml(html: string): SanitizeOutput;

/**
 * Async form of `sanitizeEntryHtml`: runs the same pipeline on the libuv
 * thread pool so large bodies never block the event loop.
 */
export function sanitizeEntryHtmlAsync(html: string): Promise<SanitizeOutput>;

/**
 * The canonical hostnames every surviving embed src is rewritten to. The
 * CSP (`src/server/http/csp.ts`) double-enforces this list in `frame-src`,
 * so it shares this single source of truth with the sanitizer.
 */
export function embedCanonicalHostnames(): string[];

/** A normalized, safe-to-render embed derived from an untrusted iframe src. */
export interface NormalizedEmbed {
  src: string;
  provider: string;
  sandbox: string;
  allow: string;
}

/**
 * Validates an untrusted iframe src against the allow-listed embed providers
 * (YouTube, Vimeo, Spotify, SoundCloud, Bandcamp, CodePen) and returns the
 * normalized embed, or null if the iframe should be dropped. Exposed for
 * tests and for TS callers that synthesize embeds (YouTube plugin).
 */
export function normalizeEmbed(src: string): NormalizedEmbed | null;

/** See `Bases` and `rewrite_urls` in `core/src/absolutize.rs`. */
export interface AbsolutizeOptions {
  /** The document's root base. */
  rootBaseUrl?: string;
  /** Bases for `src`, `poster` and `srcset`; defaults to the document's pair. */
  media?: { baseUrl: string; rootBaseUrl?: string };
  /** Moves inlined raster images out to `{imageUrlPrefix}{name}`. */
  imageUrlPrefix?: string;
}

/** An inlined image moved out of the HTML, to be stored under its name. */
export interface ExtractedImage {
  name: string;
  contentType: string;
  data: Buffer;
}

export interface AbsolutizeOutput {
  html: string;
  images: ExtractedImage[];
}

/**
 * See `rewrite_urls` in `core/src/absolutize.rs`: a null `baseUrl` leaves
 * relative URLs as written. Throws when lol_html rejects the input.
 */
export function absolutizeUrls(
  html: string,
  baseUrl: string | null,
  options?: AbsolutizeOptions
): AbsolutizeOutput;

/** Async form of `absolutizeUrls`, on the libuv thread pool. */
export function absolutizeUrlsAsync(
  html: string,
  baseUrl: string | null,
  options?: AbsolutizeOptions
): Promise<AbsolutizeOutput>;
