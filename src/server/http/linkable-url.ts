/**
 * The URL as the URL parser normalizes it (`href`), if it's an absolute
 * http(s) URL, else null. Stored URLs (entry links, site URLs, preview images)
 * are whatever a feed or page said, so any output a client may render as a
 * link goes through this: a `javascript:` href runs script wherever our CSP
 * doesn't apply. Returning `href` hands clients exactly what was checked,
 * with no stray controls, whitespace or unescaped quotes for their own parser
 * to read differently.
 */
export function linkableUrl(url: string | null): string | null {
  const parsed = parseHttpUrl(url);
  return parsed === null ? null : parsed.href;
}

/**
 * The stored URL unchanged, if it's an absolute http(s) URL, else null. For
 * feed URLs, which clients and OPML re-imports match by exact string, so
 * normalizing them would read as a different feed.
 */
export function httpUrlAsStored(url: string | null): string | null {
  return parseHttpUrl(url) === null ? null : url;
}

function parseHttpUrl(url: string | null): URL | null {
  if (url === null) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}
