/**
 * Single write-path helper for persisting sanitized entry HTML.
 *
 * Sanitizing a large body with `sanitize-html` is the dominant cost of
 * `entries.get` (~50ms per ~700KB, across up to four content fields). Since the
 * output is a pure function of `(raw HTML, sanitizer allow-list)`, we compute it
 * once at write time and store it in the `*_sanitized` columns alongside a
 * `*_sanitized_version` stamp (`SANITIZER_VERSION`). The read path serves the
 * stored value when the version matches and re-sanitizes from the raw columns
 * otherwise (see `resolveSanitizedContent` in the entries router).
 *
 * Every place that writes entry content (feed create/update, full-content fetch,
 * saved articles, email ingestion) funnels its insert `values` / update `set`
 * object through `withSanitizedEntryContent` so the raw→sanitized mapping lives
 * in exactly one place and can't be forgotten at a new write site. The read-path
 * heal is the backstop that guarantees correctness even if a site ever skips it.
 *
 * Contract: write the content fields as a *family* — pass both `contentOriginal`
 * and `contentCleaned` together (and likewise both `fullContent*`), which every
 * current write site does. The sanitized columns for a family are derived only
 * when at least one of its raw fields is present in the object, so a write that
 * touches one family leaves the other untouched.
 */

import { sanitizeEntryHtml, SANITIZER_VERSION } from "./sanitize";

interface RawEntryContent {
  contentOriginal?: string | null;
  contentCleaned?: string | null;
  fullContentOriginal?: string | null;
  fullContentCleaned?: string | null;
}

interface SanitizedEntryContent {
  contentOriginalSanitized: string | null;
  contentCleanedSanitized: string | null;
  contentSanitizedVersion: number;
  fullContentOriginalSanitized: string | null;
  fullContentCleanedSanitized: string | null;
  fullContentSanitizedVersion: number;
}

/**
 * Augment an entry insert/update payload with the sanitized columns derived from
 * whichever raw content families it writes. Spread/return shape matches Drizzle
 * `.values()` / `.set()`.
 */
export function withSanitizedEntryContent<const T extends RawEntryContent>(
  values: T
): T & Partial<SanitizedEntryContent> {
  const result: T & Partial<SanitizedEntryContent> = { ...values };

  if ("contentOriginal" in values || "contentCleaned" in values) {
    result.contentOriginalSanitized = sanitizeEntryHtml(values.contentOriginal ?? null);
    result.contentCleanedSanitized = sanitizeEntryHtml(values.contentCleaned ?? null);
    result.contentSanitizedVersion = SANITIZER_VERSION;
  }

  if ("fullContentOriginal" in values || "fullContentCleaned" in values) {
    result.fullContentOriginalSanitized = sanitizeEntryHtml(values.fullContentOriginal ?? null);
    result.fullContentCleanedSanitized = sanitizeEntryHtml(values.fullContentCleaned ?? null);
    result.fullContentSanitizedVersion = SANITIZER_VERSION;
  }

  return result;
}
