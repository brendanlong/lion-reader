/**
 * The URL as the URL parser normalizes it (`href`), if it's an absolute
 * http(s) URL, else null. Every stored link (entry links, images, unsubscribe
 * and site URLs) is written through this, and the compat APIs and exports pass
 * links through it again on the way out: a `javascript:` href runs script
 * wherever our CSP doesn't apply. The `href` is what was checked, so no
 * client's parser can read it differently.
 */
export function linkableUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const { protocol, href } = new URL(url);
    if (protocol !== "http:" && protocol !== "https:") return null;
    // The parser percent-encodes these everywhere but the host, which keeps a
    // `"`; a client splicing the URL into HTML would act on any of them.
    return UNSAFE_IN_HREF.test(href) ? null : href;
  } catch {
    return null;
  }
}

const UNSAFE_IN_HREF = /[\u0000- \u007f"<>]/;

/**
 * A feed's URL as stored: `linkableUrl`'s href without the fragment, which no
 * server sees. Feeds are found by exact string, so every write and lookup of
 * `feeds.url` uses this form.
 */
export function normalizeFeedUrl(url: string | null): string | null {
  const href = linkableUrl(url);
  if (href === null) return null;
  const parsed = new URL(href);
  parsed.hash = "";
  return parsed.href;
}
