/**
 * The URL as the URL parser normalizes it (`href`), if it's an absolute
 * http(s) URL, else null. Stored URLs (entry links, site URLs, preview images)
 * are whatever a feed or page said, so any output a client may render as a
 * link goes through this: a `javascript:` href runs script wherever our CSP
 * doesn't apply. Returning `href` hands clients exactly what was checked, with
 * no stray controls or whitespace for their own parser to read differently,
 * and no unencoded `"`.
 */
export function linkableUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}
