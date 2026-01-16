/**
 * Formatting utilities for display.
 */

/**
 * Format a date as a relative time string (e.g., "2 hours ago").
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSeconds < 60) {
    return "just now";
  } else if (diffMinutes < 60) {
    return `${diffMinutes} ${diffMinutes === 1 ? "minute" : "minutes"} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? "hour" : "hours"} ago`;
  } else if (diffDays < 7) {
    return `${diffDays} ${diffDays === 1 ? "day" : "days"} ago`;
  } else if (diffDays < 30) {
    return `${diffWeeks} ${diffWeeks === 1 ? "week" : "weeks"} ago`;
  } else if (diffMonths < 12) {
    return `${diffMonths} ${diffMonths === 1 ? "month" : "months"} ago`;
  } else {
    return `${diffYears} ${diffYears === 1 ? "year" : "years"} ago`;
  }
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
 * Calculate estimated reading time from text content.
 * Strips HTML tags and counts words at 200 WPM.
 * Returns a human-readable string like "5 min read" or "< 1 min read".
 */
export function calculateReadingTime(content: string | null): string | null {
  if (!content) return null;

  // Strip HTML tags
  const textContent = content.replace(/<[^>]*>/g, "");

  // Count words (split by whitespace and filter empty strings)
  const words = textContent
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;

  // Calculate minutes at 200 words per minute
  const minutes = Math.ceil(words / 200);

  if (minutes < 1) {
    return "< 1 min read";
  }
  return `${minutes} min read`;
}
