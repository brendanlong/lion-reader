/**
 * The URL if it's an absolute http(s) URL, else null. Stored URLs (entry
 * links, site URLs, preview images) are whatever a feed or page said, so any
 * output a client may render as a link goes through this: a `javascript:`
 * href runs script wherever our CSP doesn't apply.
 */
export function linkableUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
