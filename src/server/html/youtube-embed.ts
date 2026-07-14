/**
 * YouTube embed URL handling, shared by the sanitizer's embed allow-list
 * (`embed-providers.ts`, which registers YouTube as one provider and validates
 * iframes found in feed content) and the YouTube plugin (which synthesizes
 * embed iframes for YouTube's own feeds).
 *
 * Iframes are the sanitizer's only cross-origin escape hatch, so everything
 * here is allow-list based: only known YouTube embed hosts and the /embed/
 * path shape are accepted, every src is rewritten to the privacy-enhanced
 * youtube-nocookie.com host, and only a small set of playback-related query
 * params survives (autoplay/mute/JS-API flags are dropped).
 */

// Hosts that serve the YouTube embed player.
const YOUTUBE_EMBED_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

// A single path segment after /embed/: an 11-char video id in practice, or
// the literal "videoseries" for playlist embeds. Bounded so a pathological
// path can't smuggle arbitrary content into the normalized URL.
const EMBED_PATH_RE = /^\/embed\/([A-Za-z0-9_-]{1,64})$/;

// Query params preserved on embed URLs: playback position, playlists, and
// captions/localization. Everything else (autoplay, mute, enablejsapi,
// origin, widget_referrer, ...) is dropped.
const ALLOWED_EMBED_PARAMS = new Set([
  "start",
  "end",
  "list",
  "listType",
  "loop",
  "playlist",
  "rel",
  "cc_load_policy",
  "cc_lang_pref",
  "hl",
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
 * Validates an iframe src as a YouTube embed and returns the normalized
 * https://www.youtube-nocookie.com/embed/... URL, or null if the src is not a
 * YouTube embed.
 */
export function normalizeYouTubeEmbedUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  const trimmed = src.trim();
  // Feeds commonly use protocol-relative embed srcs.
  const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;

  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!YOUTUBE_EMBED_HOSTS.has(url.hostname.toLowerCase())) return null;

  const match = EMBED_PATH_RE.exec(url.pathname);
  if (!match) return null;

  const normalized = new URL(`https://www.youtube-nocookie.com/embed/${match[1]}`);
  for (const [key, value] of url.searchParams) {
    if (ALLOWED_EMBED_PARAMS.has(key)) {
      normalized.searchParams.set(key, value);
    }
  }
  return normalized.toString();
}

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
