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
 * Format a future date as a relative time string (e.g., "In 2 hours").
 * Returns "Not scheduled" for null, "Pending" for past dates.
 */
export function formatFutureTime(date: Date | null): string {
  if (!date) return "Not scheduled";

  const now = new Date();
  const dateObj = new Date(date);
  const diffMs = dateObj.getTime() - now.getTime();

  // If in the past, it's scheduled to run soon
  if (diffMs <= 0) {
    return "Pending";
  }

  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 60) {
    return `In ${diffMins} minute${diffMins === 1 ? "" : "s"}`;
  } else if (diffHours < 24) {
    return `In ${diffHours} hour${diffHours === 1 ? "" : "s"}`;
  } else {
    return `In ${diffDays} day${diffDays === 1 ? "" : "s"}`;
  }
}

/**
 * Format a byte count as a human-readable string (e.g., "1.5 MB").
 * Returns "--" for null values.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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
 * Get display name for a feed, using a fallback chain:
 * customTitle → title → URL domain → "Unknown Feed"
 */
export function getFeedDisplayName(feed: {
  customTitle?: string | null;
  title: string | null;
  url: string | null;
}): string {
  if (feed.customTitle) return feed.customTitle;
  if (feed.title) return feed.title;
  if (feed.url) return getDomain(feed.url);
  return "Unknown Feed";
}
