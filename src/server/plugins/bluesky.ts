import type { UrlPlugin, SavedArticleContent } from "./types";
import { escapeHtml } from "@/server/http/html";
import { readResponseWithSizeLimit } from "@/server/http/fetch";
import { USER_AGENT } from "@/server/http/user-agent";
import { logger } from "@/lib/logger";

/**
 * Bluesky plugin using the public AT Protocol appview API.
 *
 * Bluesky serves standards-compliant per-profile RSS at
 * `bsky.app/profile/{handle}/rss`, so ordinary subscription/feed handling
 * already works. But posts with embeds (quote posts, images, link cards,
 * videos) come through the RSS `<description>` as the bare placeholder
 * `[contains quote post or other embedded content]` — the actual embedded
 * content is dropped. And the JS-rendered post page yields nothing to
 * Readability.
 *
 * This plugin provides only a `savedArticle` capability: on full-content fetch
 * (or when saving a post URL) it hydrates the post via the public, unauthenticated
 * XRPC API and renders the text plus its embeds as clean HTML. There is
 * deliberately no `feed` capability — native RSS is left to the normal path.
 */

// Public appview: unauthenticated read access to hydrated post/profile views.
const BLUESKY_API_BASE = "https://public.api.bsky.app/xrpc";
const BLUESKY_API_TIMEOUT_MS = 10000;
// Hydrated post JSON is small; cap defensively anyway.
const BLUESKY_API_MAX_BYTES = 1024 * 1024;

// ============================================================================
// URL parsing
// ============================================================================

interface BlueskyPostRef {
  /** Handle (e.g. "alice.bsky.social") or a DID ("did:plc:..."). */
  identifier: string;
  /** Post record key (the trailing path segment). */
  rkey: string;
}

/**
 * Parse a `bsky.app/profile/{identifier}/post/{rkey}` URL into its parts.
 * Returns null for any other bsky.app URL (profiles, feeds, the RSS URL, etc.)
 * so the caller falls back to normal handling.
 */
export function parseBlueskyPostUrl(url: URL): BlueskyPostRef | null {
  const host = url.hostname.toLowerCase();
  if (host !== "bsky.app" && host !== "www.bsky.app") {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean);
  // /profile/{identifier}/post/{rkey}
  if (parts.length !== 4 || parts[0] !== "profile" || parts[2] !== "post") {
    return null;
  }
  const identifier = decodeURIComponent(parts[1]);
  const rkey = decodeURIComponent(parts[3]);
  if (!identifier || !rkey) {
    return null;
  }
  return { identifier, rkey };
}

// ============================================================================
// AT Protocol response types (only the fields we render)
// ============================================================================

interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{
    $type?: string;
    uri?: string;
    did?: string;
    tag?: string;
  }>;
}

interface PostRecord {
  $type?: string;
  text?: string;
  facets?: Facet[];
  createdAt?: string;
}

interface Author {
  did: string;
  handle: string;
  displayName?: string | null;
}

interface ImageView {
  thumb?: string;
  fullsize?: string;
  alt?: string;
}

interface ExternalView {
  uri: string;
  title?: string;
  description?: string;
  thumb?: string;
}

/** A hydrated embed view (`app.bsky.embed.*#view`). */
interface EmbedView {
  $type?: string;
  // images#view
  images?: ImageView[];
  // external#view
  external?: ExternalView;
  // video#view
  thumbnail?: string;
  alt?: string;
  // record#view — the embedded record (may be a viewRecord or a not-found/blocked stub)
  record?: EmbeddedRecordView;
  // recordWithMedia#view
  media?: EmbedView;
}

/** The `record` field of an `app.bsky.embed.record#view`. */
interface EmbeddedRecordView {
  $type?: string;
  uri?: string;
  author?: Author;
  // For recordWithMedia, the inner record is nested one more level.
  record?: EmbeddedRecordView;
  // The quoted post's own record value + its hydrated embeds.
  value?: PostRecord;
  embeds?: EmbedView[];
}

interface PostView {
  uri: string;
  author: Author;
  record?: PostRecord;
  embed?: EmbedView;
}

interface GetPostsResponse {
  posts?: PostView[];
}

interface ResolveHandleResponse {
  did?: string;
}

// ============================================================================
// Rich-text rendering
// ============================================================================

/** Escape text and turn newlines into `<br>`. */
function textToHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

/** Only allow http(s) links through (the read-path sanitizer also enforces this). */
function isHttpUrl(uri: string): boolean {
  return /^https?:\/\//i.test(uri);
}

/**
 * Render a single facet segment (already-decoded UTF-8 text) as a link/mention/
 * tag, falling back to plain escaped text for unknown features.
 */
function renderFacetSegment(
  segment: string,
  feature: Facet["features"][number] | undefined
): string {
  const type = feature?.$type;
  if (type === "app.bsky.richtext.facet#link" && feature?.uri && isHttpUrl(feature.uri)) {
    return `<a href="${escapeHtml(feature.uri)}">${textToHtml(segment)}</a>`;
  }
  if (type === "app.bsky.richtext.facet#mention" && feature?.did) {
    return `<a href="https://bsky.app/profile/${escapeHtml(feature.did)}">${textToHtml(segment)}</a>`;
  }
  if (type === "app.bsky.richtext.facet#tag" && feature?.tag) {
    return `<a href="https://bsky.app/hashtag/${encodeURIComponent(feature.tag)}">${textToHtml(segment)}</a>`;
  }
  return textToHtml(segment);
}

/**
 * Render post text as an HTML paragraph, applying facets (links, mentions,
 * hashtags). Facet indices are UTF-8 **byte** offsets, so we slice the encoded
 * bytes rather than JS string indices. Overlapping/out-of-range facets are
 * skipped defensively.
 */
export function renderRichText(text: string, facets: Facet[] | undefined): string {
  if (!text) return "";
  const bytes = Buffer.from(text, "utf-8");
  const valid = (facets ?? [])
    .filter(
      (f) =>
        f.index &&
        Number.isInteger(f.index.byteStart) &&
        Number.isInteger(f.index.byteEnd) &&
        f.index.byteStart >= 0 &&
        f.index.byteEnd <= bytes.length &&
        f.index.byteStart < f.index.byteEnd
    )
    .sort((a, b) => a.index.byteStart - b.index.byteStart);

  const parts: string[] = [];
  let cursor = 0;
  for (const facet of valid) {
    const { byteStart, byteEnd } = facet.index;
    // Skip a facet that overlaps one we already emitted.
    if (byteStart < cursor) continue;
    parts.push(textToHtml(bytes.subarray(cursor, byteStart).toString("utf-8")));
    const segment = bytes.subarray(byteStart, byteEnd).toString("utf-8");
    parts.push(renderFacetSegment(segment, facet.features?.[0]));
    cursor = byteEnd;
  }
  parts.push(textToHtml(bytes.subarray(cursor).toString("utf-8")));
  return `<p>${parts.join("")}</p>`;
}

// ============================================================================
// Embed rendering
// ============================================================================

function renderImages(images: ImageView[]): string {
  return images
    .map((img) => {
      const src = img.fullsize || img.thumb;
      if (!src || !isHttpUrl(src)) return "";
      const alt = img.alt ? escapeHtml(img.alt) : "";
      const caption = img.alt ? `<figcaption>${escapeHtml(img.alt)}</figcaption>` : "";
      return `<figure><img src="${escapeHtml(src)}" alt="${alt}" loading="lazy">${caption}</figure>`;
    })
    .filter(Boolean)
    .join("\n");
}

function renderExternal(external: ExternalView): string {
  if (!external.uri || !isHttpUrl(external.uri)) return "";
  const title = external.title ? escapeHtml(external.title) : escapeHtml(external.uri);
  const thumb =
    external.thumb && isHttpUrl(external.thumb)
      ? `<img src="${escapeHtml(external.thumb)}" alt="" loading="lazy">`
      : "";
  const description = external.description
    ? `<figcaption>${escapeHtml(external.description)}</figcaption>`
    : "";
  return `<figure><a href="${escapeHtml(external.uri)}">${thumb}<strong>${title}</strong></a>${description}</figure>`;
}

function renderVideo(embed: EmbedView, postUrl: string): string {
  // The video is served as an HLS playlist that a bare <video> can't play, so
  // link to the post (optionally with the poster thumbnail).
  const thumb =
    embed.thumbnail && isHttpUrl(embed.thumbnail)
      ? `<img src="${escapeHtml(embed.thumbnail)}" alt="${embed.alt ? escapeHtml(embed.alt) : ""}" loading="lazy">`
      : "";
  return `<figure><a href="${escapeHtml(postUrl)}">${thumb}<strong>Watch video on Bluesky</strong></a></figure>`;
}

/** Human-facing author label: display name, falling back to `@handle`. */
function authorLabel(author: Author | undefined): string {
  if (!author) return "";
  return author.displayName?.trim() || `@${author.handle}`;
}

/** URL of an embedded record's post page, derived from its AT-URI. */
function embeddedRecordUrl(record: EmbeddedRecordView): string | null {
  // at://{did}/app.bsky.feed.post/{rkey}
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(record.uri ?? "");
  if (!match) return null;
  const handle = record.author?.handle ?? match[1];
  return `https://bsky.app/profile/${handle}/post/${match[2]}`;
}

/** Render a quoted post as a blockquote (author line, text, its own embeds). */
function renderEmbeddedRecord(record: EmbeddedRecordView): string {
  const type = record.$type;
  if (type === "app.bsky.embed.record#viewNotFound") {
    return `<blockquote><p>[Quoted post not found]</p></blockquote>`;
  }
  if (type === "app.bsky.embed.record#viewBlocked") {
    return `<blockquote><p>[Quoted post is blocked]</p></blockquote>`;
  }
  if (type === "app.bsky.embed.record#viewDetached") {
    return `<blockquote><p>[Quoted post was removed]</p></blockquote>`;
  }
  // Only app.bsky.feed.post records carry text/embeds worth rendering; other
  // record types (feed generators, lists, starter packs) are linked, not inlined.
  const value = record.value;
  if (!value || value.$type === undefined) {
    // Non-post embedded record — link it if we can.
    const url = embeddedRecordUrl(record);
    const label = authorLabel(record.author);
    if (url) {
      return `<blockquote><p><a href="${escapeHtml(url)}">Quoted content${label ? ` by ${escapeHtml(label)}` : ""}</a></p></blockquote>`;
    }
    return "";
  }

  const parts: string[] = [];
  const label = authorLabel(record.author);
  const url = embeddedRecordUrl(record);
  if (label) {
    const cite = url ? `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>` : escapeHtml(label);
    parts.push(`<p><cite>${cite}</cite></p>`);
  }
  if (value.text) {
    parts.push(renderRichText(value.text, value.facets));
  }
  for (const embed of record.embeds ?? []) {
    parts.push(renderEmbedView(embed, url ?? ""));
  }
  const inner = parts.filter(Boolean).join("\n");
  return inner ? `<blockquote>${inner}</blockquote>` : "";
}

/** Render any hydrated embed view. `postUrl` is used for video fallback links. */
function renderEmbedView(embed: EmbedView, postUrl: string): string {
  const type = embed.$type;
  if (type === "app.bsky.embed.images#view" && embed.images) {
    return renderImages(embed.images);
  }
  if (type === "app.bsky.embed.external#view" && embed.external) {
    return renderExternal(embed.external);
  }
  if (type === "app.bsky.embed.video#view") {
    return renderVideo(embed, postUrl);
  }
  if (type === "app.bsky.embed.record#view" && embed.record) {
    return renderEmbeddedRecord(embed.record);
  }
  if (type === "app.bsky.embed.recordWithMedia#view") {
    const media = embed.media ? renderEmbedView(embed.media, postUrl) : "";
    // For recordWithMedia the quoted record is nested at embed.record.record.
    const inner = embed.record?.record ?? embed.record;
    const quote = inner ? renderEmbeddedRecord(inner) : "";
    return [media, quote].filter(Boolean).join("\n");
  }
  return "";
}

// ============================================================================
// Post rendering (pure, unit-testable)
// ============================================================================

/**
 * Render a hydrated Bluesky post view as clean article HTML: the post text
 * (with rich-text facets) followed by its embeds. Pure function — no network —
 * so it can be unit-tested against captured API fixtures.
 */
export function renderBlueskyPostHtml(post: PostView, postUrl: string): string {
  const parts: string[] = [];
  const text = post.record?.text ?? "";
  if (text.trim()) {
    parts.push(renderRichText(text, post.record?.facets));
  }
  if (post.embed) {
    parts.push(renderEmbedView(post.embed, postUrl));
  }
  return parts.filter(Boolean).join("\n");
}

/**
 * Build a saved-article title from a post: the first line of text (trimmed to a
 * reasonable length), falling back to "Post by {author}". Bluesky posts have no
 * real title; this only surfaces where a title is required (saved-article list).
 */
export function blueskyPostTitle(post: PostView): string {
  const firstLine = (post.record?.text ?? "").split("\n")[0].trim();
  if (firstLine) {
    return firstLine.length > 100 ? `${firstLine.slice(0, 99)}…` : firstLine;
  }
  return `Post by ${authorLabel(post.author)}`;
}

// ============================================================================
// API fetching
// ============================================================================

async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(BLUESKY_API_TIMEOUT_MS),
  });
  if (!response.ok) {
    logger.debug("Bluesky API request failed", { url, status: response.status });
    return null;
  }
  const body = await readResponseWithSizeLimit(response, BLUESKY_API_MAX_BYTES, url);
  return JSON.parse(body) as T;
}

/** Resolve a handle to a DID; passes DIDs through unchanged. */
async function resolveIdentifierToDid(identifier: string): Promise<string | null> {
  if (identifier.startsWith("did:")) {
    return identifier;
  }
  const url = `${BLUESKY_API_BASE}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(identifier)}`;
  const data = await fetchJson<ResolveHandleResponse>(url);
  return data?.did ?? null;
}

async function fetchBlueskyPost(url: URL): Promise<SavedArticleContent | null> {
  const ref = parseBlueskyPostUrl(url);
  if (!ref) {
    return null;
  }

  const did = await resolveIdentifierToDid(ref.identifier);
  if (!did) {
    logger.debug("Could not resolve Bluesky identifier", { identifier: ref.identifier });
    return null;
  }

  const atUri = `at://${did}/app.bsky.feed.post/${ref.rkey}`;
  const getPostsUrl = `${BLUESKY_API_BASE}/app.bsky.feed.getPosts?uris=${encodeURIComponent(atUri)}`;
  const data = await fetchJson<GetPostsResponse>(getPostsUrl);
  const post = data?.posts?.[0];
  if (!post) {
    logger.debug("Bluesky post not found", { atUri });
    return null;
  }

  const html = renderBlueskyPostHtml(post, url.href);
  if (!html) {
    return null;
  }

  const createdAt = post.record?.createdAt;
  return {
    html,
    title: blueskyPostTitle(post),
    author: authorLabel(post.author) || null,
    publishedAt: createdAt ? new Date(createdAt) : null,
    canonicalUrl: url.href,
  };
}

// ============================================================================
// Plugin
// ============================================================================

export const blueskyPlugin: UrlPlugin = {
  name: "bluesky",
  hosts: ["bsky.app", "www.bsky.app"],

  // Only handle individual post URLs; profiles/feeds/RSS fall through to normal
  // handling (native RSS already works).
  matchUrl(url: URL): boolean {
    return parseBlueskyPostUrl(url) !== null;
  },

  capabilities: {
    savedArticle: {
      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        try {
          return await fetchBlueskyPost(url);
        } catch (error) {
          logger.warn("Failed to fetch Bluesky content", {
            url: url.href,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }
      },

      // Our rendered HTML is already clean; Readability would mangle the short
      // post + embeds structure.
      skipReadability: true,
      siteName: "Bluesky",
    },
  },
};
