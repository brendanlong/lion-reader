/**
 * YouTube URL helpers for the YouTube plugin, which synthesizes embed iframes
 * for YouTube's own feeds and saved video pages.
 *
 * The embed rules — hosts, path shape, canonical host, sandbox, allow — live
 * only in the sanitizer's Rust allow-list (`native/sanitizer/core/src/embeds.rs`):
 * `buildYouTubeEmbedIframe` asks `normalizeEmbed` for them rather than
 * restating them, so a synthesized iframe can't drift out of what the
 * sanitizer accepts on the read path.
 */

import { normalizeEmbed } from "@lion-reader/sanitizer";
import { escapeHtml } from "@/server/http/html";
import { logger } from "@/lib/logger";

/**
 * Hostnames the YouTube plugin claims in the registry, and so the only ones
 * `extractYouTubeVideoId` can ever see. Lives here rather than in the plugin
 * so the two can't disagree — a host the registry routes to us but the
 * extractor rejects makes every URL on it fall through to a generic scrape.
 */
export const YOUTUBE_PLUGIN_HOSTS = ["www.youtube.com", "youtube.com", "m.youtube.com", "youtu.be"];

const YOUTUBE_VIDEO_PAGE_HOSTS = new Set(YOUTUBE_PLUGIN_HOSTS);

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
 * Builds the privacy-enhanced YouTube embed iframe for a video id. The
 * sanitizer re-validates the src and re-forces sandbox/allow on every read, so
 * writing them here only keeps the stored raw content self-contained — which
 * is why they're read back out of `normalizeEmbed` instead of restated.
 *
 * Returns null if the sanitizer wouldn't accept the embed. That can't happen
 * for an id `extractYouTubeVideoId` produced (its charset is a subset of the
 * sanitizer's), so it means the two have drifted — hence the log.
 */
export function buildYouTubeEmbedIframe(videoId: string, title?: string | null): string | null {
  const embed = normalizeEmbed(`https://www.youtube-nocookie.com/embed/${videoId}`);
  if (!embed) {
    logger.warn("Sanitizer rejected a synthesized YouTube embed; omitting the player", { videoId });
    return null;
  }

  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return (
    `<iframe src="${escapeHtml(embed.src)}"` +
    ` width="560" height="315"${titleAttr}` +
    ` sandbox="${escapeHtml(embed.sandbox)}" allow="${escapeHtml(embed.allow)}"` +
    ` allowfullscreen loading="lazy"></iframe>`
  );
}
