/**
 * Read-path sanitization of an entry's feed content pair.
 *
 * Entry bodies come from untrusted feeds and are rendered via
 * `dangerouslySetInnerHTML` (and served to external clients such as MCP,
 * Google Reader, and Wallabag), so they must be sanitized. As of issue #1282
 * sanitization is **no longer persisted**: the native sanitizer is fast enough
 * (~0.09 ms / 10 KB, and off the event loop for large bodies via the async
 * form) to run on every read, so we store only the raw columns and sanitize
 * here at read time. This is the single chokepoint every read path funnels
 * through — see `getFullEntry`/`getEntry` and their batch forms in
 * `@/server/services/entry-reads` and the saved-article read paths.
 *
 * Both variants are sanitized: the frontend has a user-facing original/cleaned
 * toggle for feed content (`hasBothVersions` in `EntryContentBody.tsx`).
 */

import { sanitizeEntryHtmlAsync } from "./sanitize";

/**
 * Sanitize an entry's `(original, cleaned)` content pair for display. Offloads
 * large bodies to the libuv thread pool (see `sanitizeEntryHtmlAsync`) so a big
 * body never blocks the app-server event loop; small bodies run inline.
 */
export async function sanitizeEntryContentPair(raw: {
  original: string | null;
  cleaned: string | null;
}): Promise<{ original: string | null; cleaned: string | null }> {
  const [original, cleaned] = await Promise.all([
    sanitizeEntryHtmlAsync(raw.original),
    sanitizeEntryHtmlAsync(raw.cleaned),
  ]);
  return { original, cleaned };
}
