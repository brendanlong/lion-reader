/**
 * URL manipulation utilities.
 */

/**
 * Normalizes a URL by stripping the fragment (hash) portion.
 *
 * Fragments identify a location within a page (e.g., #section-2) but
 * don't affect which resource is fetched. Two URLs that differ only
 * by fragment point to the same article.
 *
 * @example
 * normalizeUrl("https://example.com/article#section-2")
 * // => "https://example.com/article"
 *
 * normalizeUrl("https://example.com/page?q=test#top")
 * // => "https://example.com/page?q=test"
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href;
  } catch {
    // If URL is invalid, return as-is (validation will catch it later)
    return url;
  }
}
