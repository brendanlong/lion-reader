/**
 * Entry Content Helpers
 *
 * Shared helper functions for entry content components.
 */

/**
 * Format a date as a readable string.
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Extract domain from URL for display.
 */
export function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Swipe gesture configuration constants.
 */
export const SWIPE_CONFIG = {
  /** Minimum horizontal distance for swipe */
  SWIPE_THRESHOLD: 50,
  /** Maximum vertical movement allowed */
  MAX_VERTICAL_DISTANCE: 100,
} as const;
