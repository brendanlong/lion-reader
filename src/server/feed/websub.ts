/**
 * WebSub utility functions.
 * Provides helpers for WebSub (PubSubHubbub) support including:
 * - Checking if WebSub can be used (requires public URL)
 * - Generating callback URLs and secrets
 */

/**
 * Private/local hostnames and IP ranges that can't receive WebSub callbacks.
 */
const PRIVATE_HOSTNAMES = ["localhost", "127.0.0.1", "0.0.0.0", "::1"];

/**
 * Private IP address prefixes (RFC 1918 and RFC 4193).
 */
const PRIVATE_IP_PREFIXES = [
  "10.",
  "172.16.",
  "172.17.",
  "172.18.",
  "172.19.",
  "172.20.",
  "172.21.",
  "172.22.",
  "172.23.",
  "172.24.",
  "172.25.",
  "172.26.",
  "172.27.",
  "172.28.",
  "172.29.",
  "172.30.",
  "172.31.",
  "192.168.",
];

/**
 * Checks if a hostname is private (local or internal network).
 *
 * @param hostname - The hostname to check
 * @returns true if the hostname is private
 */
function isPrivateHostname(hostname: string): boolean {
  // Check exact matches for localhost variants
  if (PRIVATE_HOSTNAMES.includes(hostname.toLowerCase())) {
    return true;
  }

  // Check for private IP prefixes
  for (const prefix of PRIVATE_IP_PREFIXES) {
    if (hostname.startsWith(prefix)) {
      return true;
    }
  }

  // Check for .local domain suffix (mDNS)
  if (hostname.toLowerCase().endsWith(".local")) {
    return true;
  }

  return false;
}

/**
 * Checks if WebSub can be used for receiving push notifications.
 *
 * WebSub requires a publicly accessible callback URL that the hub can reach.
 * This function checks if the application is configured with a public URL.
 *
 * @returns true if WebSub can be used, false otherwise
 *
 * @example
 * if (feed.hubUrl && canUseWebSub()) {
 *   await subscribeToHub(feed);
 * } else {
 *   // Fall back to polling
 *   await scheduleNextFetch(feed);
 * }
 */
export function canUseWebSub(): boolean {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;

  // WebSub requires a configured base URL
  if (!baseUrl) {
    return false;
  }

  try {
    const url = new URL(baseUrl);

    // Don't attempt WebSub for private/local hostnames
    if (isPrivateHostname(url.hostname)) {
      return false;
    }

    // Must be HTTPS in production (hubs may reject HTTP callbacks)
    // Allow HTTP for development/testing scenarios
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
      return false;
    }

    return true;
  } catch {
    // Invalid URL
    return false;
  }
}

/**
 * Gets the base URL for WebSub callbacks.
 * Returns the configured NEXT_PUBLIC_APP_URL or null if not available.
 *
 * @returns The base URL string or null
 */
export function getWebsubCallbackBaseUrl(): string | null {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!baseUrl || !canUseWebSub()) {
    return null;
  }
  // Remove trailing slash if present
  return baseUrl.replace(/\/$/, "");
}

/**
 * Generates a WebSub callback URL for a specific feed.
 *
 * @param feedId - The feed ID
 * @returns The callback URL or null if WebSub is not available
 */
export function generateCallbackUrl(feedId: string): string | null {
  const baseUrl = getWebsubCallbackBaseUrl();
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl}/api/webhooks/websub/${feedId}`;
}
