import type { UrlPlugin, SavedArticleContent } from "./types";
import type { ParsedEntry } from "@/server/feed/types";
import { Parser } from "htmlparser2";
import { escapeHtml } from "@/server/http/html";
import { fetchHtmlPage } from "@/server/http/fetch";
import { logger } from "@/lib/logger";
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
 * Builds the privacy-enhanced YouTube embed iframe for a video id. Shared by
 * the feed capability (synthesizing content from Media RSS metadata) and the
 * savedArticle capability (synthesizing content from a watch-page save).
 *
 * The sanitizer re-validates the src and re-forces sandbox/allow on the read
 * path (see transformTags.iframe in sanitize.ts); setting them here just keeps
 * the stored raw content self-contained.
 */
export function buildYouTubeEmbedIframe(videoId: string, title?: string | null): string {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return (
    `<iframe src="https://www.youtube-nocookie.com/embed/${videoId}"` +
    ` width="560" height="315"${titleAttr}` +
    ` sandbox="${YOUTUBE_IFRAME_SANDBOX}" allow="${YOUTUBE_IFRAME_ALLOW}"` +
    ` allowfullscreen loading="lazy"></iframe>`
  );
}

/**
 * Pulls a JSON string field's value out of a page's inline scripts by regex
 * (e.g. `"shortDescription":"..."` / `"author":"..."` from YouTube's embedded
 * `ytInitialPlayerResponse`). Matches a JSON string literal and JSON-parses it
 * so escapes (`\n`, `\uXXXX`, `\"`) decode correctly. Best-effort: returns null
 * if the field is absent or doesn't parse.
 */
function extractInlineJsonString(html: string, field: string): string | null {
  const match = new RegExp(`"${field}":("(?:[^"\\\\]|\\\\.)*")`).exec(html);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

interface YouTubeVideoMetadata {
  title: string | null;
  author: string | null;
  description: string | null;
}

/**
 * Extracts video metadata from a fetched YouTube watch page. Title comes from
 * the stable Open Graph tag; the description prefers the full
 * `videoDetails.shortDescription` from the embedded player JSON and falls back
 * to the (truncated) `og:description`; the author (channel name) prefers the
 * player JSON and falls back to the `<link itemprop="name">` microdata. All
 * fields are best-effort — a valid embed can still be built without them.
 */
function extractYouTubeVideoMetadata(html: string): YouTubeVideoMetadata {
  let ogTitle: string | null = null;
  let ogDescription: string | null = null;
  let itempropName: string | null = null;

  const parser = new Parser({
    onopentag(name, attribs) {
      const tag = name.toLowerCase();
      if (tag === "meta") {
        const property = attribs.property?.toLowerCase();
        const content = attribs.content;
        if (property === "og:title" && content && !ogTitle) {
          ogTitle = content;
        } else if (property === "og:description" && content && !ogDescription) {
          ogDescription = content;
        }
      } else if (
        tag === "link" &&
        attribs.itemprop?.toLowerCase() === "name" &&
        attribs.content &&
        !itempropName
      ) {
        itempropName = attribs.content;
      }
    },
  });
  parser.write(html);
  parser.end();

  return {
    title: ogTitle,
    author: extractInlineJsonString(html, "author") ?? itempropName,
    description: extractInlineJsonString(html, "shortDescription") ?? ogDescription,
  };
}

/**
 * Synthesizes the saved-article body for a YouTube video: the embed player plus
 * the description, matching the feed path's `buildEntryContent`. Pure so the
 * synthesis is unit-testable without network mocking — `fetchContent` just
 * supplies the fetched watch-page HTML (or null when it couldn't be fetched, in
 * which case a titleless embed is still produced).
 */
export function synthesizeYouTubeSavedArticle(
  videoId: string,
  watchPageHtml: string | null
): SavedArticleContent {
  const metadata = watchPageHtml
    ? extractYouTubeVideoMetadata(watchPageHtml)
    : { title: null, author: null, description: null };
  const iframe = buildYouTubeEmbedIframe(videoId, metadata.title);
  const description = metadata.description ? youtubeDescriptionToHtml(metadata.description) : "";
  return {
    html: iframe + description,
    title: metadata.title,
    author: metadata.author,
    // The canonical watch URL for this video, used as the base for resolving
    // relative URLs in the content. Note this does NOT change the saved
    // article's guid/url: saveArticle keys those off the caller's original URL
    // (normalizeSavedUrl(params.url)), so saving the same video via youtu.be vs.
    // watch?v=... still produces distinct saved articles.
    canonicalUrl: `https://www.youtube.com/watch?v=${videoId}`,
  };
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
 * Provides two capabilities:
 *
 * - `feed` for YouTube's RSS feeds (`/feeds/videos.xml?channel_id=...`,
 *   `?playlist_id=...`, `?user=...`): a polling floor so we don't hammer
 *   YouTube's aggressively rate-limited feed endpoint (see
 *   YOUTUBE_MIN_FETCH_INTERVAL_SECONDS), and entry-content synthesis — the feed
 *   entries carry no HTML body, only Media RSS metadata, so `buildEntryContent`
 *   builds one from the embedded player plus the `media:description` (#1115).
 *
 * - `savedArticle` for video-page URLs (watch / youtu.be / shorts / live /
 *   embed): saving a YouTube video otherwise runs Readability over the watch
 *   page, which fails (it's a JS app) and stores an unwatchable footer scrape.
 *   Instead we synthesize the same embed-player-plus-description body from the
 *   watch page's metadata, mirroring the feed path.
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
  hosts: ["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"],

  matchUrl(url: URL): boolean {
    // Feed URLs (handled by the `feed` capability).
    if (
      url.pathname === "/feeds/videos.xml" &&
      (url.searchParams.has("channel_id") ||
        url.searchParams.has("playlist_id") ||
        url.searchParams.has("user"))
    ) {
      return true;
    }
    // Video-page URLs (watch / youtu.be / shorts / live / embed), handled by
    // the `savedArticle` capability. Channel/search/other pages return false so
    // they're handled generically. `getFeedPlugin` may resolve the plugin for
    // these, but the feed sub-capabilities it uses (transformToFeedUrl,
    // cleanEntryContent) are undefined here, so it's a no-op there.
    return extractYouTubeVideoId(url.href) !== null;
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

        const iframe = buildYouTubeEmbedIframe(videoId, entry.title);
        const description = entry.mediaDescription
          ? youtubeDescriptionToHtml(entry.mediaDescription)
          : "";
        return iframe + description;
      },
    },

    savedArticle: {
      // The synthesized body (embed iframe + description) is clean HTML we
      // build ourselves — Readability would strip the iframe and fail on it.
      skipReadability: true,
      siteName: "YouTube",

      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        const videoId = extractYouTubeVideoId(url.href);
        // Not a video-page URL (e.g. a channel page that slipped through) —
        // fall back to normal fetching.
        if (!videoId) return null;

        // Fetch the watch page for metadata. Best-effort: a blocked/failed
        // fetch still yields a working embed (just without a title/description),
        // which beats falling back to the unwatchable generic scrape.
        let watchPageHtml: string | null = null;
        try {
          const result = await fetchHtmlPage(`https://www.youtube.com/watch?v=${videoId}`);
          if (result.content && !result.isMarkdown) {
            watchPageHtml = result.content;
          }
        } catch (error) {
          logger.warn("Failed to fetch YouTube watch page for saved-article metadata", {
            videoId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        return synthesizeYouTubeSavedArticle(videoId, watchPageHtml);
      },
    },
  },
};
