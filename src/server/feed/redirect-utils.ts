/**
 * Pure redirect tracking utilities.
 *
 * This module contains pure functions for analyzing redirect chains that don't
 * require database access. Extracted to allow unit testing without database imports.
 */

import type { RedirectInfo } from "./fetcher";

/**
 * Wait period before applying permanent redirect migrations.
 * We require the redirect to be consistently seen for this duration to avoid
 * premature migrations due to temporary server misconfigurations.
 */
export const REDIRECT_WAIT_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Finds the URL that the original feed permanently moved to.
 *
 * Walks the redirect chain from the start, following hops only while they are
 * permanent (301/308). It stops at the first temporary hop, because a permanent
 * migration is only justified when every hop from the original URL up to the
 * target was itself permanent. For example, `302 A→B, 301 B→C` must NOT migrate
 * A to C: A never permanently moved (its first hop is temporary), so C is only
 * reachable via a hop the server told us not to cache.
 *
 * Returns null if the first hop is temporary (no permanent prefix) or if the
 * resulting URL matches the original URL.
 *
 * @param redirects - The redirect chain from the fetch (in order from the origin)
 * @param originalUrl - The original feed URL we started with
 * @returns The permanent redirect target URL, or null if none applies
 */
export function findPermanentRedirectUrl(
  redirects: RedirectInfo[],
  originalUrl: string
): string | null {
  // Walk from the start, following only while hops are permanent. The last
  // permanent hop before the first temporary hop (or the end of the chain) is
  // where the feed actually permanently moved to.
  let finalUrl: string | null = null;
  for (const redirect of redirects) {
    if (redirect.type !== "permanent") {
      break;
    }
    finalUrl = redirect.url;
  }

  if (finalUrl === null) {
    return null;
  }

  // Don't consider it a redirect if we end up at the same URL
  if (finalUrl === originalUrl) {
    return null;
  }

  return finalUrl;
}

/**
 * Checks if a redirect is just an HTTP to HTTPS upgrade.
 * These can be applied immediately without a wait period.
 *
 * @param originalUrl - The original URL
 * @param redirectUrl - The redirect destination URL
 * @returns True if this is just a protocol upgrade
 */
export function isHttpToHttpsUpgrade(originalUrl: string, redirectUrl: string): boolean {
  try {
    const original = new URL(originalUrl);
    const redirect = new URL(redirectUrl);

    // Must be http -> https upgrade
    if (original.protocol !== "http:" || redirect.protocol !== "https:") {
      return false;
    }

    // Everything else must match (host, port, pathname, search, hash)
    return (
      original.host === redirect.host &&
      original.pathname === redirect.pathname &&
      original.search === redirect.search
    );
  } catch {
    return false;
  }
}
