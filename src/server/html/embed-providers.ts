/**
 * Allow-listed iframe embed providers, used by the sanitizer (`sanitize.ts`) to
 * decide which cross-origin iframes may survive in entry content.
 *
 * Iframes are the sanitizer's only cross-origin escape hatch. An unrestricted
 * iframe would let a feed embed an arbitrary page full-bleed inside the reader's
 * trusted UI — a phishing / clickjacking / tracking surface (issue #922). So the
 * policy is **block-by-default, opt-in per provider**: an iframe survives only if
 * its src matches one of the known media-embed providers below.
 *
 * Every provider follows the same defense-in-depth recipe (same as the original
 * YouTube-only handling in #1115):
 *
 *  1. Parse the src as an http(s) URL (protocol-relative `//host` is treated as
 *     https, since feeds commonly use it).
 *  2. Reject unless the hostname is one of the provider's known embed hosts.
 *  3. Validate the path against a strict, bounded regex so a pathological path
 *     can't smuggle arbitrary content through.
 *  4. Rebuild the URL from scratch on the provider's *canonical* host, copying
 *     only an allow-list of query params (each validated where it carries a
 *     nested URL). Autoplay / JS-API / tracking params are dropped.
 *  5. The sanitizer then forces a per-provider `sandbox`/`allow` regardless of
 *     what the feed supplied.
 *
 * Because step 4 rewrites every surviving src to a canonical host, the set of
 * canonical hosts (`EMBED_CANONICAL_HOSTNAMES`) also backstops the rule via
 * sanitize-html's `allowedIframeHostnames`.
 *
 * To add a provider: append an `EmbedProvider` here and (if it introduces a new
 * canonical host) it is picked up automatically by `EMBED_CANONICAL_HOSTNAMES`.
 * Keep `matchUrl`/path regexes selective — a provider must only match URLs it
 * can actually render as an embed, never "any URL on my hosts".
 */

import {
  normalizeYouTubeEmbedUrl,
  YOUTUBE_IFRAME_ALLOW,
  YOUTUBE_IFRAME_SANDBOX,
} from "./youtube-embed";

/** A normalized, safe-to-render embed derived from an untrusted iframe src. */
export interface NormalizedEmbed {
  /** Canonical, rewritten src URL. */
  src: string;
  /** Human-readable provider name (for a "removed embed" placeholder, etc.). */
  provider: string;
  /** Forced `sandbox` attribute value. */
  sandbox: string;
  /** Forced `allow` (Permissions-Policy) attribute value. */
  allow: string;
}

interface EmbedProvider {
  name: string;
  /**
   * Validates and normalizes an iframe src for this provider. Returns the
   * canonical rewritten URL, or null if the src is not a valid embed for it.
   */
  normalize: (src: string) => string | null;
  sandbox: string;
  allow: string;
}

/**
 * Sandbox shared by the media-player embeds. Players need scripts and their own
 * origin's storage; popups (with sandbox escape) let "Watch/Listen on <site>"
 * open a normal tab. `allow-same-origin` is safe because the framed content is
 * always cross-origin (a canonical provider host), never our own origin — so it
 * grants the frame *its* origin, not ours.
 *
 * This is the same sandbox the YouTube handling has always used
 * (`YOUTUBE_IFRAME_SANDBOX`); the other players have the same needs.
 */
const STANDARD_EMBED_SANDBOX = YOUTUBE_IFRAME_SANDBOX;

/**
 * Parses an untrusted iframe src into an http(s) URL, treating protocol-relative
 * `//host/...` as https (common in feeds). Returns null for anything unparseable
 * or non-http(s).
 */
function parseHttpUrl(src: string | null | undefined): URL | null {
  if (!src) return null;
  const trimmed = src.trim();
  const absolute = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  let url: URL;
  try {
    url = new URL(absolute);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url;
}

/** Copies only allow-listed query params from `from` onto `to`. */
function copyParams(from: URL, to: URL, allowed: ReadonlySet<string>): void {
  for (const [key, value] of from.searchParams) {
    if (allowed.has(key)) to.searchParams.set(key, value);
  }
}

// --- Vimeo -----------------------------------------------------------------
// https://player.vimeo.com/video/{numericId}?h={hash}
const VIMEO_HOSTS = new Set(["player.vimeo.com"]);
const VIMEO_PATH_RE = /^\/video\/(\d{1,20})$/;
const VIMEO_PARAMS = new Set([
  "h", // private/unlisted video hash — required for those, must be preserved
  "title",
  "byline",
  "portrait",
  "badge",
  "color",
  "loop",
  "muted",
  "dnt",
]);
function normalizeVimeoEmbedUrl(src: string): string | null {
  const url = parseHttpUrl(src);
  if (!url || !VIMEO_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = VIMEO_PATH_RE.exec(url.pathname);
  if (!match) return null;
  const out = new URL(`https://player.vimeo.com/video/${match[1]}`);
  copyParams(url, out, VIMEO_PARAMS);
  return out.toString();
}

// --- Spotify ---------------------------------------------------------------
// https://open.spotify.com/embed[-podcast]/{type}/{id}
const SPOTIFY_HOSTS = new Set(["open.spotify.com"]);
const SPOTIFY_PATH_RE =
  /^\/embed(?:-podcast)?\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{1,64})$/;
const SPOTIFY_PARAMS = new Set(["theme", "t"]);
function normalizeSpotifyEmbedUrl(src: string): string | null {
  const url = parseHttpUrl(src);
  if (!url || !SPOTIFY_HOSTS.has(url.hostname.toLowerCase())) return null;
  const match = SPOTIFY_PATH_RE.exec(url.pathname);
  if (!match) return null;
  const out = new URL(`https://open.spotify.com${url.pathname}`);
  copyParams(url, out, SPOTIFY_PARAMS);
  return out.toString();
}

// --- SoundCloud ------------------------------------------------------------
// https://w.soundcloud.com/player/?url={soundcloud track url}&...visual flags
const SOUNDCLOUD_HOSTS = new Set(["w.soundcloud.com"]);
const SOUNDCLOUD_PATH_RE = /^\/player\/?$/;
const SOUNDCLOUD_PARAMS = new Set([
  "color",
  "hide_related",
  "show_comments",
  "show_user",
  "show_reposts",
  "show_teaser",
  "visual",
  "start_track",
  "single_active",
]);
function isSoundCloudResourceUrl(value: string): boolean {
  const url = parseHttpUrl(value);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  return (
    host === "soundcloud.com" || host === "api.soundcloud.com" || host.endsWith(".soundcloud.com")
  );
}
function normalizeSoundCloudEmbedUrl(src: string): string | null {
  const url = parseHttpUrl(src);
  if (!url || !SOUNDCLOUD_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (!SOUNDCLOUD_PATH_RE.test(url.pathname)) return null;
  // The `url` param carries the actual track/playlist — required, and it must
  // point at SoundCloud so the frame can't be pointed at an arbitrary resource.
  const resource = url.searchParams.get("url");
  if (!resource || !isSoundCloudResourceUrl(resource)) return null;
  const out = new URL("https://w.soundcloud.com/player/");
  out.searchParams.set("url", resource);
  copyParams(url, out, SOUNDCLOUD_PARAMS);
  return out.toString();
}

// --- Bandcamp --------------------------------------------------------------
// https://bandcamp.com/EmbeddedPlayer/album=123/size=large/.../ (params in path)
const BANDCAMP_HOSTS = new Set(["bandcamp.com"]);
const BANDCAMP_PATH_RE = /^\/EmbeddedPlayer(?:\/[a-z_]+=[A-Za-z0-9]+)+\/?$/;
function normalizeBandcampEmbedUrl(src: string): string | null {
  const url = parseHttpUrl(src);
  if (!url || !BANDCAMP_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (!BANDCAMP_PATH_RE.test(url.pathname)) return null;
  // Path is fully validated above; no query params are used by the player.
  return `https://bandcamp.com${url.pathname}`;
}

// --- CodePen ---------------------------------------------------------------
// https://codepen.io/{user}/embed[/preview]/{slug}. Only codepen.io serves this
// embed path shape; cdpn.io (CodePen's debug/fullpage host) uses a different
// path structure, so it's deliberately not accepted here.
const CODEPEN_HOSTS = new Set(["codepen.io"]);
const CODEPEN_PATH_RE = /^\/[A-Za-z0-9_-]+\/embed\/(?:preview\/)?[A-Za-z0-9]+\/?$/;
const CODEPEN_PARAMS = new Set(["default-tab", "theme-id", "height", "editable"]);
function normalizeCodePenEmbedUrl(src: string): string | null {
  const url = parseHttpUrl(src);
  if (!url || !CODEPEN_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (!CODEPEN_PATH_RE.test(url.pathname)) return null;
  const out = new URL(`https://codepen.io${url.pathname}`);
  copyParams(url, out, CODEPEN_PARAMS);
  return out.toString();
}

/**
 * Registry of allow-listed embed providers. Order matters only in that the
 * first match wins; hosts are disjoint so order is effectively irrelevant.
 */
const EMBED_PROVIDERS: readonly EmbedProvider[] = [
  {
    name: "YouTube",
    normalize: normalizeYouTubeEmbedUrl,
    sandbox: STANDARD_EMBED_SANDBOX,
    allow: YOUTUBE_IFRAME_ALLOW,
  },
  {
    name: "Vimeo",
    normalize: normalizeVimeoEmbedUrl,
    sandbox: STANDARD_EMBED_SANDBOX,
    allow: "fullscreen; encrypted-media; picture-in-picture",
  },
  {
    name: "Spotify",
    normalize: normalizeSpotifyEmbedUrl,
    sandbox: STANDARD_EMBED_SANDBOX,
    allow: "encrypted-media; clipboard-write; fullscreen; picture-in-picture",
  },
  {
    name: "SoundCloud",
    normalize: normalizeSoundCloudEmbedUrl,
    sandbox: STANDARD_EMBED_SANDBOX,
    allow: "encrypted-media; fullscreen",
  },
  {
    name: "Bandcamp",
    normalize: normalizeBandcampEmbedUrl,
    sandbox: STANDARD_EMBED_SANDBOX,
    allow: "encrypted-media",
  },
  {
    name: "CodePen",
    normalize: normalizeCodePenEmbedUrl,
    sandbox: STANDARD_EMBED_SANDBOX,
    allow: "",
  },
];

/**
 * The canonical hostnames every surviving embed src is rewritten to. Used as
 * sanitize-html's `allowedIframeHostnames` backstop, so even if `normalizeEmbed`
 * were somehow bypassed, only these hosts can appear in an iframe src.
 */
export const EMBED_CANONICAL_HOSTNAMES: readonly string[] = [
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "open.spotify.com",
  "w.soundcloud.com",
  "bandcamp.com",
  "codepen.io",
];

/**
 * Validates an untrusted iframe src against the allow-listed providers and
 * returns the normalized embed (canonical src + forced sandbox/allow), or null
 * if the src is not a recognized embed and the iframe should be dropped.
 */
export function normalizeEmbed(src: string | null | undefined): NormalizedEmbed | null {
  if (!src) return null;
  for (const provider of EMBED_PROVIDERS) {
    const normalized = provider.normalize(src);
    if (normalized) {
      return {
        src: normalized,
        provider: provider.name,
        sandbox: provider.sandbox,
        allow: provider.allow,
      };
    }
  }
  return null;
}
