/**
 * Single write-path helper for persisting sanitized entry HTML.
 *
 * Sanitizing a large body with `sanitize-html` is the dominant cost of
 * `entries.get` (~50ms per ~700KB, across up to four content fields). Since the
 * output is a pure function of `(raw HTML, sanitizer allow-list)`, we compute it
 * once at write time and store it in the `*_sanitized` columns alongside a
 * `*_sanitized_version` stamp (`SANITIZER_VERSION`). The read path serves the
 * stored value when the version matches and re-sanitizes from the raw columns
 * otherwise (see `resolveSanitizedContent` in `@/server/services/entries`).
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

import { sanitizeEntryHtmlInWorker } from "@/server/worker-thread/pool";
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

/**
 * Pre-sanitized values a caller has already computed (via the same
 * `sanitizeEntryHtml`) and wants to reuse instead of paying to sanitize again —
 * e.g. the cleaned HTML that `cleanContentInWorker({ sanitizeCleaned: true })`
 * sanitized inside its worker task. Each field, when provided, MUST equal
 * `sanitizeEntryHtml(values.<field>)`; it is only trusted when the corresponding
 * raw field is present in `values`. This keeps this helper the single place that
 * assigns the `*_sanitized` columns while letting fused work be reused.
 */
interface PresanitizedEntryContent {
  contentOriginalSanitized?: string | null;
  contentCleanedSanitized?: string | null;
  fullContentOriginalSanitized?: string | null;
  fullContentCleanedSanitized?: string | null;
}

/**
 * Async form of `withSanitizedEntryContent` that offloads large-body
 * sanitization to a worker thread (see `sanitizeEntryHtmlInWorker`), keeping the
 * sanitize-html pass off the main event loop on app-server request paths. Small
 * bodies still run inline. Use this from UI-serving code paths (saved articles,
 * on-demand full-content fetch, read-path re-sanitize); background jobs should
 * keep using the synchronous `withSanitizedEntryContent`.
 *
 * `presanitized` lets a caller supply already-computed sanitized values to
 * avoid redundant work (see `PresanitizedEntryContent`); when a field is absent
 * from it, that field is sanitized here.
 */
export async function withSanitizedEntryContentAsync<const T extends RawEntryContent>(
  values: T,
  presanitized: PresanitizedEntryContent = {}
): Promise<T & Partial<SanitizedEntryContent>> {
  const result: T & Partial<SanitizedEntryContent> = { ...values };

  const sanitize = (
    raw: string | null | undefined,
    reuse: string | null | undefined,
    hasReuse: boolean
  ): Promise<string | null> =>
    hasReuse ? Promise.resolve(reuse ?? null) : sanitizeEntryHtmlInWorker(raw ?? null);

  if ("contentOriginal" in values || "contentCleaned" in values) {
    const [original, cleaned] = await Promise.all([
      sanitize(
        values.contentOriginal,
        presanitized.contentOriginalSanitized,
        "contentOriginalSanitized" in presanitized
      ),
      sanitize(
        values.contentCleaned,
        presanitized.contentCleanedSanitized,
        "contentCleanedSanitized" in presanitized
      ),
    ]);
    result.contentOriginalSanitized = original;
    result.contentCleanedSanitized = cleaned;
    result.contentSanitizedVersion = SANITIZER_VERSION;
  }

  if ("fullContentOriginal" in values || "fullContentCleaned" in values) {
    const [original, cleaned] = await Promise.all([
      sanitize(
        values.fullContentOriginal,
        presanitized.fullContentOriginalSanitized,
        "fullContentOriginalSanitized" in presanitized
      ),
      sanitize(
        values.fullContentCleaned,
        presanitized.fullContentCleanedSanitized,
        "fullContentCleanedSanitized" in presanitized
      ),
    ]);
    result.fullContentOriginalSanitized = original;
    result.fullContentCleanedSanitized = cleaned;
    result.fullContentSanitizedVersion = SANITIZER_VERSION;
  }

  return result;
}
