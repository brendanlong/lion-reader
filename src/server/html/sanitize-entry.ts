/**
 * Read-path sanitization of entry content families.
 *
 * Entry bodies come from untrusted feeds and are rendered via
 * `dangerouslySetInnerHTML` (and served to external clients such as MCP,
 * Google Reader, and Wallabag), so they must be sanitized. As of issue #1282
 * sanitization is **no longer persisted**: the native sanitizer is fast enough
 * (~0.09 ms / 10 KB, and off the event loop for large bodies via the async
 * form) to run on every read, so we store only the raw columns and sanitize
 * here at read time. This is the single chokepoint every read path funnels
 * through — see `getEntry`/`getEntries`/`toFullEntry` in
 * `@/server/services/entries` and the saved-article read paths.
 *
 * A content "family" is an `(original, cleaned)` pair. The **content** family
 * serves both variants — the frontend has a user-facing original/cleaned toggle
 * for feed content (`hasBothVersions` in `EntryContentBody.tsx`) — so both are
 * sanitized. The **full-content** family's serving rule is strictly
 * `cleaned ?? original` with no toggle, so the (whole raw fetched page)
 * `original` is displayed only when `cleaned` is NULL. We therefore sanitize
 * `original` only in that case — otherwise it is never shown, so we skip the
 * whole-page sanitize and return `null`, exactly what consumers already expect
 * from the `cleaned ?? original` fallback.
 */

import { sanitizeEntryHtmlAsync } from "./sanitize";

/**
 * Sanitize one content family's raw columns for display. Offloads large bodies
 * to the libuv thread pool (see `sanitizeEntryHtmlAsync`) so a big body never
 * blocks the app-server event loop; small bodies run inline.
 */
export async function sanitizeEntryContentFamily(
  family: "content" | "fullContent",
  raw: { original: string | null; cleaned: string | null }
): Promise<{ original: string | null; cleaned: string | null }> {
  // Full-content original is served only as the `cleaned ?? original` fallback,
  // so skip sanitizing it (and return null) whenever cleaned is present.
  const sanitizeOriginal = family === "content" || raw.cleaned == null;
  const [original, cleaned] = await Promise.all([
    sanitizeOriginal ? sanitizeEntryHtmlAsync(raw.original) : Promise.resolve<string | null>(null),
    sanitizeEntryHtmlAsync(raw.cleaned),
  ]);
  return { original, cleaned };
}
