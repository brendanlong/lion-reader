import type { UrlPlugin } from "./types";
import type { ParsedEntry } from "@/server/feed/types";
import { escapeHtml } from "@/server/http/html";
import {
  extractYouTubeVideoId,
  YOUTUBE_IFRAME_ALLOW,
  YOUTUBE_IFRAME_SANDBOX,
} from "@/server/html/youtube-embed";

/**
 * Minimum polling interval for YouTube feeds: 1 hour.
 *
 * YouTube serves `Cache-Control: max-age=900` on its feeds, which would have
 * the scheduler poll every subscribed channel every 15 minutes. YouTube also
 * rate-limits RSS fetches per IP (403/429 blocks lasting hours, worse from
 * datacenter IPs) and, since late 2025, returns 404 for all feeds for a few
 * hours most days (see issue #1114 and miniflux/v2#4261). Fetching 4x more
 * often than hourly buys little — the feed only exposes the latest 15
 * videos — while multiplying the per-IP request volume that triggers blocks.
 */
export const YOUTUBE_MIN_FETCH_INTERVAL_SECONDS = 60 * 60;

/**
 * Converts a plain-text YouTube video description to HTML: escapes it, turns
 * blank-line-separated blocks into paragraphs (single newlines into <br>), and
 * links bare http(s) URLs (YouTube descriptions are full of them).
 */
export function youtubeDescriptionToHtml(description: string): string {
  const paragraphs = description
    .split(/\n{2,}/)
    .map((block) => linkifyEscapedText(escapeHtml(block.trim())).replace(/\n/g, "<br>"))
    .filter((block) => block.length > 0);
  return paragraphs.map((p) => `<p>${p}</p>`).join("");
}

/**
 * Wraps bare http(s) URLs in already-HTML-escaped text with <a> tags. Escaped
 * text contains no raw `<`/`"`, so a match is safe to place in an href
 * attribute as-is (entities like `&amp;` decode back to the original URL).
 */
function linkifyEscapedText(escapedText: string): string {
  return escapedText.replace(/https?:\/\/[^\s]+/g, (match) => {
    // Trailing sentence punctuation is almost never part of the URL; a
    // trailing `)` only is when the URL itself contains `(`.
    let url = match.replace(/[.,!?]+$/, "");
    if (url.endsWith(")") && !url.includes("(")) {
      url = url.slice(0, -1);
    }
    const trailer = match.slice(url.length);
    return `<a href="${url}">${url}</a>${trailer}`;
  });
}

/**
 * YouTube plugin.
 *
 * Provides feed capability for YouTube's RSS feeds
 * (`/feeds/videos.xml?channel_id=...`, `?playlist_id=...`, `?user=...`):
 * a polling floor so we don't hammer YouTube's aggressively rate-limited feed
 * endpoint (see YOUTUBE_MIN_FETCH_INTERVAL_SECONDS), and entry-content
 * synthesis — the feed entries carry no HTML body, only Media RSS metadata,
 * so `buildEntryContent` builds one from the embedded player plus the
 * `media:description` (issue #1115).
 *
 * Note: YouTube supports WebSub push for channel feeds via Google's hub
 * (https://developers.google.com/youtube/v3/guides/push_notifications), but
 * the feeds don't advertise it (no rel="hub" link), the pushed payload is a
 * stub (generic feed title, entries without metadata), and the hub has a
 * documented history of silently dropping deliveries — so we deliberately
 * stay on polling instead of hard-coding the hub here.
 */
export const youtubePlugin: UrlPlugin = {
  name: "youtube",
  hosts: ["www.youtube.com", "youtube.com", "m.youtube.com"],

  matchUrl(url: URL): boolean {
    // Only feed URLs; watch/channel/etc. pages are handled generically.
    return (
      url.pathname === "/feeds/videos.xml" &&
      (url.searchParams.has("channel_id") ||
        url.searchParams.has("playlist_id") ||
        url.searchParams.has("user"))
    );
  },

  capabilities: {
    feed: {
      minFetchIntervalSeconds: YOUTUBE_MIN_FETCH_INTERVAL_SECONDS,

      buildEntryContent(entry: ParsedEntry, entryUrl: string | undefined): string | null {
        // Video id from the entry link (watch?v=...), falling back to the
        // Atom guid (`yt:video:VIDEOID`).
        const videoId =
          extractYouTubeVideoId(entryUrl) ??
          (entry.guid?.startsWith("yt:video:")
            ? extractYouTubeVideoId(
                `https://www.youtube.com/watch?v=${entry.guid.slice("yt:video:".length)}`
              )
            : null);
        if (!videoId) return null;

        // The sanitizer re-validates the src and re-forces sandbox/allow on
        // the read path (see transformTags.iframe in sanitize.ts); setting
        // them here just keeps the stored raw content self-contained.
        const title = entry.title ? ` title="${escapeHtml(entry.title)}"` : "";
        const iframe =
          `<iframe src="https://www.youtube-nocookie.com/embed/${videoId}"` +
          ` width="560" height="315"${title}` +
          ` sandbox="${YOUTUBE_IFRAME_SANDBOX}" allow="${YOUTUBE_IFRAME_ALLOW}"` +
          ` allowfullscreen loading="lazy"></iframe>`;

        const description = entry.mediaDescription
          ? youtubeDescriptionToHtml(entry.mediaDescription)
          : "";
        return iframe + description;
      },
    },
  },
};
