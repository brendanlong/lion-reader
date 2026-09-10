/**
 * YouTube URL helpers for the YouTube plugin, which synthesizes embed iframes
 * for YouTube's own feeds and saved video pages.
 *
 * The embed rules themselves (hosts, path shape, canonical host, sandbox,
 * allow) live only in the sanitizer's Rust allow-list
 * (`native/sanitizer/core/src/embeds.rs`): `buildYouTubeEmbedIframe` asks
 * `normalizeEmbed` for them rather than restating them, so a synthesized
 * iframe can't drift out of what the sanitizer accepts on the read path.
 */

import { normalizeEmbed } from "@lion-reader/sanitizer";
import { escapeHtml } from "@/server/http/html";

/**
 * Hosts that serve YouTube *video pages*. A separate rule from the sanitizer's
 * embed-src allow-list, not a copy of it: this one recognizes watch/shorts/live
 * pages to pull a video id out of, and nothing it accepts becomes an iframe
 * src — `buildYouTubeEmbedIframe` gets that from the sanitizer.
 */
const YOUTUBE_VIDEO_PAGE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/**
 * Extracts a YouTube video id from a video page URL (watch, youtu.be, shorts,
 * live, or embed form). Returns null for anything else.
 */
export function extractYouTubeVideoId(urlString: string | null | undefined): string | null {
  if (!urlString) return null;

  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  const isVideoId = (id: string | null | undefined): id is string =>
    !!id && /^[A-Za-z0-9_-]{5,20}$/.test(id);

  if (hostname === "youtu.be") {
    const id = url.pathname.slice(1);
    return isVideoId(id) ? id : null;
  }

  if (!YOUTUBE_VIDEO_PAGE_HOSTS.has(hostname)) return null;

  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v");
    return isVideoId(id) ? id : null;
  }

  const pathMatch = /^\/(?:shorts|live|embed)\/([^/]+)$/.exec(url.pathname);
  if (pathMatch && isVideoId(pathMatch[1])) {
    return pathMatch[1];
  }

  return null;
}

/**
 * Builds the privacy-enhanced YouTube embed iframe for a video id, with the
 * src/sandbox/allow the sanitizer would force on the read path. Returns null
 * if the sanitizer wouldn't accept the embed, so a caller emits no iframe
 * rather than one that will be dropped when the entry is read.
 */
export function buildYouTubeEmbedIframe(videoId: string, title?: string | null): string | null {
  const embed = normalizeEmbed(`https://www.youtube-nocookie.com/embed/${videoId}`);
  if (!embed) return null;

  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return (
    `<iframe src="${escapeHtml(embed.src)}"` +
    ` width="560" height="315"${titleAttr}` +
    ` sandbox="${escapeHtml(embed.sandbox)}" allow="${escapeHtml(embed.allow)}"` +
    ` allowfullscreen loading="lazy"></iframe>`
  );
}
