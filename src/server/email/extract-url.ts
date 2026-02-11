/**
 * Extract the canonical URL from newsletter email HTML.
 *
 * Many newsletter platforms (Substack, Buttondown, Ghost, etc.) include
 * a link to the web version of the post in the email HTML. This module
 * extracts that URL so entries have a "Read on {domain}" link.
 *
 * Strategy:
 * 1. Look for `<a>` tags inside heading elements (h1-h3) - the post title link
 * 2. Filter out tracking/redirect URLs and return a clean canonical URL
 *
 * Uses htmlparser2 for SAX-style streaming parsing per project conventions.
 */

import { Parser } from "htmlparser2";

/**
 * Domains that host tracking redirects rather than actual content.
 * URLs on these domains should be skipped when looking for canonical URLs.
 */
const TRACKING_DOMAINS = new Set([
  "email.mg1.substack.com",
  "email.mg2.substack.com",
  "click.convertkit-mail.com",
  "click.convertkit-mail2.com",
  "email.mailgun.com",
  "links.email.example.com",
  "trk.klclick.com",
  "t.co",
  "bit.ly",
]);

/**
 * URL path patterns that indicate tracking pixels, unsubscribe links,
 * or other non-content URLs.
 */
const NON_CONTENT_PATH_PATTERNS = [
  /\/unsubscribe/i,
  /\/subscribe/i,
  /\/manage[_-]?preferences/i,
  /\/email[_-]?preferences/i,
  /\/open\?/i, // tracking pixels
  /\/click\?/i, // click tracking
];

/**
 * Checks if a URL is likely a content URL rather than tracking/navigation.
 *
 * @param url - The URL to check
 * @returns true if the URL appears to be a content URL
 */
function isContentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Must be http or https
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    // Skip known tracking domains
    if (TRACKING_DOMAINS.has(parsed.hostname)) {
      return false;
    }

    // Skip non-content paths
    for (const pattern of NON_CONTENT_PATH_PATTERNS) {
      if (pattern.test(parsed.pathname + parsed.search)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves Substack app-link URLs to their canonical form.
 *
 * Substack emails use URLs like:
 *   https://substack.com/app-link/post?publication_id=89120&post_id=182110210&...
 *
 * The "Read in app" links use the cleaner form:
 *   https://open.substack.com/pub/{publication}/p/{slug}
 *
 * Since we can't resolve the app-link to a clean URL without fetching it,
 * we pass through any URL that looks like it points to real content.
 *
 * @param url - The URL to check/resolve
 * @returns The URL if it's usable, or null if it should be skipped
 */
function resolveSubstackUrl(url: string): string | null {
  try {
    const parsed = new URL(url);

    // Skip substack.com/app-link URLs - they're deep links to the app,
    // not web-accessible content
    if (parsed.hostname === "substack.com" && parsed.pathname.startsWith("/app-link/")) {
      return null;
    }

    // open.substack.com/pub/*/p/* URLs are clean canonical URLs
    if (parsed.hostname === "open.substack.com") {
      // Strip tracking parameters but keep the path
      const clean = new URL(parsed.pathname, "https://open.substack.com");
      return clean.href;
    }

    // *.substack.com URLs with /p/ paths are canonical post URLs
    if (parsed.hostname.endsWith(".substack.com") && parsed.pathname.startsWith("/p/")) {
      // Strip tracking parameters
      const clean = new URL(parsed.pathname, `https://${parsed.hostname}`);
      return clean.href;
    }

    return url;
  } catch {
    return url;
  }
}

/**
 * Cleans a URL by removing common tracking parameters.
 *
 * @param url - The URL to clean
 * @returns The cleaned URL
 */
function cleanTrackingParams(url: string): string {
  try {
    const parsed = new URL(url);

    const trackingParams = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "r",
      "token",
      "isFreemail",
      "action",
      "triggerShare",
      "submitLike",
      "comments",
    ];

    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }

    // If no search params remain, remove the trailing ?
    if (parsed.searchParams.toString() === "") {
      return parsed.origin + parsed.pathname + parsed.hash;
    }

    return parsed.href;
  } catch {
    return url;
  }
}

/**
 * Checks if a URL looks like an unsubscribe link based on its path.
 *
 * @param url - The URL to check
 * @returns true if the URL appears to be an unsubscribe link
 */
function isUnsubscribeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Must be https or http
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    // Skip known tracking redirect domains - these are click trackers, not actual unsub pages
    if (TRACKING_DOMAINS.has(parsed.hostname)) {
      return false;
    }

    // Check if the path contains unsubscribe-related patterns
    const pathAndQuery = parsed.pathname + parsed.search;
    return /\/unsubscribe/i.test(pathAndQuery);
  } catch {
    return false;
  }
}

/**
 * Extracts the unsubscribe URL from newsletter email HTML.
 *
 * Looks for `<a>` tags whose visible text contains "unsubscribe" (case-insensitive).
 * Returns the first matching URL that has an unsubscribe-related path.
 * Falls back to links whose text contains "unsubscribe" even without an
 * unsubscribe path, since some services use generic URLs.
 *
 * Uses htmlparser2 for SAX-style streaming parsing per project conventions.
 *
 * @param html - The email HTML content
 * @returns The extracted unsubscribe URL, or null if not found
 */
export function extractUnsubscribeUrl(html: string): string | null {
  if (!html) {
    return null;
  }

  let insideAnchor = false;
  let currentHref: string | null = null;
  let currentText = "";
  let bestMatch: string | null = null;
  let hasPathMatch = false;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name.toLowerCase() === "a" && attribs.href) {
          insideAnchor = true;
          currentHref = attribs.href;
          currentText = "";
        }
      },
      ontext(text) {
        if (insideAnchor) {
          currentText += text;
        }
      },
      onclosetag(name) {
        if (name.toLowerCase() === "a" && insideAnchor) {
          if (currentHref && /unsubscribe/i.test(currentText)) {
            try {
              const parsed = new URL(currentHref);
              if (parsed.protocol === "http:" || parsed.protocol === "https:") {
                if (!TRACKING_DOMAINS.has(parsed.hostname)) {
                  if (isUnsubscribeUrl(currentHref)) {
                    // Path-based match - highest priority, take first one
                    if (!hasPathMatch) {
                      bestMatch = currentHref;
                      hasPathMatch = true;
                    }
                  } else if (!bestMatch) {
                    // Text-only match - fallback, take first one
                    bestMatch = currentHref;
                  }
                }
              }
            } catch {
              // Invalid URL, skip
            }
          }
          insideAnchor = false;
          currentHref = null;
          currentText = "";
        }
      },
    },
    { decodeEntities: true }
  );

  parser.write(html);
  parser.end();

  return bestMatch;
}

/**
 * Extracts the canonical post URL from newsletter email HTML.
 *
 * Looks for `<a>` tags inside heading elements (h1-h3), which is the most
 * common pattern across newsletter platforms for linking to the web version
 * of a post.
 *
 * @param html - The email HTML content
 * @returns The extracted URL, or null if no suitable URL was found
 */
export function extractEmailUrl(html: string): string | null {
  if (!html) {
    return null;
  }

  let headingDepth = 0;
  let currentHeadingLevel = 0;
  let foundUrl: string | null = null;

  const parser = new Parser(
    {
      onopentagname(name) {
        const tag = name.toLowerCase();

        // Track heading elements
        if (tag === "h1" || tag === "h2" || tag === "h3") {
          headingDepth++;
          currentHeadingLevel = parseInt(tag[1]);
        }
      },
      onopentag(name, attribs) {
        const tag = name.toLowerCase();

        // Look for <a> tags inside headings
        if (tag === "a" && headingDepth > 0 && attribs.href) {
          const href = attribs.href;

          // Check if it's a Substack URL that needs special handling
          const resolved = resolveSubstackUrl(href);
          if (!resolved) {
            return;
          }

          // Check if it's a content URL (not tracking/unsubscribe)
          if (isContentUrl(resolved)) {
            const cleaned = cleanTrackingParams(resolved);
            if (!foundUrl || currentHeadingLevel < parseInt(foundUrl[0])) {
              foundUrl = cleaned;
              parser.pause();
            }
          }
        }
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (tag === "h1" || tag === "h2" || tag === "h3") {
          headingDepth--;
        }
      },
    },
    { decodeEntities: true }
  );

  parser.write(html);
  parser.end();

  return foundUrl;
}
