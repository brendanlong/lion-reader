/**
 * Type definitions for the native Markdown renderer (`native/markdown/`).
 *
 * Hand-maintained to match the `#[napi]` exports in src/lib.rs — there is no
 * @napi-rs/cli codegen step. Keep them in sync; the loader's drift guard only
 * catches a missing export, not a wrong signature.
 */

/** Byte budgets for one render. Both are enforced inside the renderer. */
export interface MarkdownLimits {
  /** Maximum size of the Markdown source, in bytes. */
  maxInputBytes: number;
  /** Maximum size of the rendered HTML, in bytes. */
  maxOutputBytes: number;
}

/**
 * The outcome of a render. Rendering is otherwise infallible — malformed
 * Markdown and malformed TeX both degrade to output — so a budget is the only
 * way this reports failure. napi omits `None` fields rather than emitting
 * null, so exactly one key is present and the union narrows on either.
 */
export type RenderedMarkdown =
  | { html: string; limitExceeded?: undefined }
  | { html?: undefined; limitExceeded: "input" | "output" };

/**
 * Renders Markdown to HTML (synchronous). Use for background jobs; request
 * paths should use {@link renderMarkdownAsync}.
 */
export function renderMarkdown(markdown: string, limits: MarkdownLimits): RenderedMarkdown;

/**
 * Renders Markdown to HTML on the libuv thread pool, so a large document never
 * blocks the event loop.
 */
export function renderMarkdownAsync(
  markdown: string,
  limits: MarkdownLimits
): Promise<RenderedMarkdown>;
