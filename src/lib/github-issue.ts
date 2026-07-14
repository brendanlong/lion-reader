/**
 * Helpers for filing GitHub issues about broken feeds.
 *
 * We don't post issues on the user's behalf (that would require a write-scoped
 * token and lets users spam the public tracker). Instead we build a prefilled
 * GitHub "new issue" URL and open it in a new tab, so the user reviews and
 * submits the issue themselves under their own account.
 */

/** The Lion Reader repository on GitHub. */
export const LION_READER_REPO_URL = "https://github.com/brendanlong/lion-reader";

/** The public issue tracker URL. */
export const LION_READER_ISSUES_URL = `${LION_READER_REPO_URL}/issues`;

export interface FeedIssueInput {
  /** Feed title, if known. */
  title: string | null;
  /** Feed URL, if known. */
  url: string | null;
  /** The most recent fetch error message. */
  lastError: string | null;
  /** Number of consecutive fetch failures. */
  consecutiveFailures: number;
}

/**
 * Build a prefilled GitHub "new issue" URL for a broken feed. Opening it lands
 * the user on GitHub's issue form with the title and body already populated;
 * they review and submit it themselves.
 */
export function buildFeedIssueUrl(feed: FeedIssueInput): string {
  const feedName = feed.title?.trim() || feed.url || "Unknown feed";
  const issueTitle = `Broken feed: ${feedName}`;

  const body = [
    "<!-- Filed from the Lion Reader broken-feeds settings page. -->",
    "",
    `**Feed URL:** ${feed.url ?? "(unknown)"}`,
    "",
    `**Consecutive failures:** ${feed.consecutiveFailures}`,
    "",
    "**Error message:**",
    "",
    "```",
    feed.lastError ?? "(no error message recorded)",
    "```",
    "",
    "I've confirmed the feed link works in a browser and believe Lion Reader should be able to fetch it.",
  ].join("\n");

  const params = new URLSearchParams({
    title: issueTitle,
    body,
    labels: "bug",
  });

  return `${LION_READER_REPO_URL}/issues/new?${params.toString()}`;
}
