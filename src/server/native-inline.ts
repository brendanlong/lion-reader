/**
 * Inputs at or below this size are handled synchronously by our native
 * modules' `*Async` entry points (sanitizer, content extractor, Markdown
 * renderer, feed and OPML parsers) instead of scheduling a libuv-thread-pool
 * task: the native code finishes in well under a millisecond for them, so the
 * fixed cost of the async hop (and copying the string across the N-API
 * boundary twice) isn't worth paying. ~10 KB.
 */
export const NATIVE_INLINE_MAX_CHARS = 10 * 1024;
