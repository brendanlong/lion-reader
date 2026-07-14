/**
 * FeedSiteLink
 *
 * Renders an external link to a feed's website (the `<link rel="alternate">` /
 * RSS `<link>` / JSON Feed `home_page_url` parsed into `feeds.site_url`). Shown
 * beneath the subscription entry-list title and on the feed stats page. Displays
 * the hostname as a compact, clean label and opens in a new tab. Renders nothing
 * when the feed has no site URL.
 */

import { ExternalLinkIcon } from "@/components/ui/icon-button";

interface FeedSiteLinkProps {
  siteUrl: string | null | undefined;
  /** Extra classes for spacing/sizing at the call site. */
  className?: string;
}

export function FeedSiteLink({ siteUrl, className = "" }: FeedSiteLinkProps) {
  if (!siteUrl) return null;

  // Prefer the bare hostname as the label; fall back to the raw URL if it isn't
  // parseable (a malformed value the parser stored verbatim).
  let label = siteUrl;
  try {
    label = new URL(siteUrl).hostname;
  } catch {
    label = siteUrl;
  }

  return (
    <a
      href={siteUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`text-muted hover:text-accent ui-text-sm inline-flex max-w-full items-center gap-1 ${className}`}
    >
      <ExternalLinkIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </a>
  );
}
