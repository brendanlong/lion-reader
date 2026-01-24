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
 * Finds the final URL from a permanent redirect chain.
 * Returns null if there are no permanent redirects or if the final URL
 * matches the original URL.
 *
 * @param redirects - The redirect chain from the fetch
 * @param originalUrl - The original feed URL we started with
 * @returns The final permanent redirect URL, or null if none
 */
export function findPermanentRedirectUrl(
  redirects: RedirectInfo[],
  originalUrl: string
): string | null {
  // Find all permanent redirects in the chain
  const permanentRedirects = redirects.filter((r) => r.type === "permanent");

  if (permanentRedirects.length === 0) {
    return null;
  }

  // The final URL is the last redirect's URL
  const finalUrl = permanentRedirects[permanentRedirects.length - 1].url;

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
