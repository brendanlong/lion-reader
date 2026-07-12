import type { UrlPlugin } from "./types";

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
 * YouTube plugin.
 *
 * Provides feed capability for YouTube's RSS feeds
 * (`/feeds/videos.xml?channel_id=...`, `?playlist_id=...`, `?user=...`):
 * currently just a polling floor so we don't hammer YouTube's aggressively
 * rate-limited feed endpoint (see YOUTUBE_MIN_FETCH_INTERVAL_SECONDS).
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
    },
  },
};
