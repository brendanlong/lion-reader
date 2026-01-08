/**
 * User-Agent header utilities.
 *
 * Provides a standardized User-Agent string for all outgoing HTTP requests.
 * The format includes:
 * - App name and version
 * - Git commit SHA (if available)
 * - Optional context (e.g., feed ID)
 * - App URL (primary contact)
 * - GitHub repository URL
 * - Contact email (if configured)
 *
 * Format: LionReader/1.0[-COMMIT] [context] (+APP_URL; GITHUB_URL; EMAIL)
 */

import { fetcherConfig } from "../config/env";

// ============================================================================
// Constants
// ============================================================================

/**
 * GitHub repository URL for reference.
 */
const GITHUB_URL = "https://github.com/brendanlong/lion-reader";

/**
 * App name and base version.
 */
const APP_NAME_VERSION = "LionReader/1.0";

// ============================================================================
// User-Agent Builder
// ============================================================================

/**
 * Options for building a User-Agent string.
 */
export interface UserAgentOptions {
  /**
   * Optional context to include in the User-Agent.
   * For feed fetching, this is typically the feed ID for debugging.
   * Example: "feed:abc123"
   */
  context?: string;
}

/**
 * Builds a standardized User-Agent string for outgoing HTTP requests.
 *
 * Format: LionReader/1.0-COMMIT context (+APP_URL; GITHUB_URL; EMAIL)
 * - COMMIT: Git commit SHA if available
 * - context: Optional context string (e.g., "feed:abc123")
 * - APP_URL: NEXT_PUBLIC_APP_URL with + prefix (primary contact)
 * - GITHUB_URL: Always included for reference
 * - EMAIL: Contact email if configured
 *
 * @param options - Optional configuration for the User-Agent
 * @returns The formatted User-Agent string
 *
 * @example
 * // Basic usage
 * buildUserAgent()
 * // => "LionReader/1.0-abc1234 (+https://lionreader.com; https://github.com/brendanlong/lion-reader; admin@example.com)"
 *
 * @example
 * // With feed context
 * buildUserAgent({ context: "feed:abc123" })
 * // => "LionReader/1.0-abc1234 feed:abc123 (+https://lionreader.com; ...)"
 */
export function buildUserAgent(options?: UserAgentOptions): string {
  // Version with optional commit hash
  let ua = APP_NAME_VERSION;
  if (fetcherConfig.commitSha) {
    ua += `-${fetcherConfig.commitSha}`;
  }

  // Optional context (e.g., feed ID for debugging)
  if (options?.context) {
    ua += ` ${options.context}`;
  }

  // Build comment section with URLs and contact info
  const parts: string[] = [];

  if (fetcherConfig.appUrl) {
    // App URL gets the + prefix as primary contact point
    parts.push(`+${fetcherConfig.appUrl}`);
  }

  // Always include GitHub URL
  parts.push(GITHUB_URL);

  if (fetcherConfig.contactEmail) {
    parts.push(fetcherConfig.contactEmail);
  }

  ua += ` (${parts.join("; ")})`;

  return ua;
}

/**
 * Pre-built User-Agent string for general use.
 *
 * This is a convenience export for cases where no context is needed.
 * For feed fetching, prefer calling buildUserAgent({ context: `feed:${feedId}` })
 * to include the feed ID for debugging.
 *
 * Note: This is evaluated at module load time, so it will use the config
 * values available at that point. For dynamic values, use buildUserAgent().
 */
export const USER_AGENT = buildUserAgent();
