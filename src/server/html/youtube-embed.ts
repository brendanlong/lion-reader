/**
 * YouTube embed pieces used by the YouTube plugin, which synthesizes embed
 * iframes for YouTube's own feeds.
 *
 * Validating/normalizing embed srcs found in *feed* content is the sanitizer's
 * job and lives in Rust (`normalize_youtube_embed_url` in
 * `native/sanitizer/core/src/embeds.rs`) — don't add a second TypeScript copy
 * of that rule here.
 */

// Hosts that serve the YouTube embed player.
const YOUTUBE_EMBED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/**
 * Sandbox for YouTube embed iframes. The player needs scripts and its own
 * origin's storage; popups (with sandbox escape) let "Watch on YouTube" open
 * a normal tab. `allow-same-origin` is safe here because the framed content
 * is always cross-origin (youtube-nocookie.com), never our own origin.
 */
export const YOUTUBE_IFRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation";

/** Permissions-policy grants for the embed (no autoplay). */
export const YOUTUBE_IFRAME_ALLOW = "fullscreen; encrypted-media; picture-in-picture";

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

  if (!YOUTUBE_EMBED_HOSTS.has(hostname)) return null;

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
