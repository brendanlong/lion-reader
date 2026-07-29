import type { UrlPlugin, SavedArticleContent } from "./types";
import { socialPostTitle } from "./social-post";
import { fetchPluginPage } from "./fetch-page";
import { Parser } from "htmlparser2";
import { escapeHtml, plainTextToHtml } from "@/server/http/html";
import { safeDecodeURIComponent } from "@/lib/url";
import { logger } from "@/lib/logger";

/**
 * Threads plugin (saved articles only).
 *
 * The official Threads API reads only the authenticated user's own posts;
 * reading anyone else's public post needs the Keyword Search API, which
 * requires Meta App Review plus business verification. The token-free
 * `graph.threads.net/oembed` endpoint returns only the `<blockquote>` shell
 * that `embed.js` hydrates client-side — no post text. And the post page is a
 * JS app: Readability returns nothing usable on it at all (verified against a
 * real post page — extraction fails outright, unlike LinkedIn where it merely
 * does a worse job than the page's own metadata).
 *
 * What is available is Open Graph: a Threads post page serves the complete post
 * text in `og:description` (the posts are short, so it isn't elided the way
 * `twitter:description` is) and the author in `og:title`. Unlike LinkedIn's,
 * this `og:description` *is* the post rather than a description of something
 * the post links to, which is why reading it as the body is sound here.
 *
 * Known limitations:
 * - **No publish date.** The page carries no `<time>`, no JSON-LD, and no
 *   timestamp in its inline payload, and the post shortcode doesn't encode one.
 * - **Media is partial.** An attached image is rendered when Threads advertises
 *   one (see {@link postImageUrl}); carousels and some single-image posts don't
 *   advertise theirs and are missed. Video is never available.
 * - `threads.com/robots.txt` is `Disallow: /` for a generic user agent. This is
 *   a user-initiated single-post fetch on save, not crawling; don't extend it
 *   into anything that walks profiles or tags.
 */

// ============================================================================
// URL parsing
// ============================================================================

const THREADS_HOSTS = new Set(["threads.com", "www.threads.com", "threads.net", "www.threads.net"]);

/**
 * Parse a URL that identifies a single Threads post, returning its id. Threads
 * hands out three forms and a saved URL can be any of them:
 *
 * - `/@handle/post/{code}` — canonical, with or without the SEO slug appended
 * - `/t/{code}` — short permalink, used by embeds
 * - `/share/{code}` — what the app's share sheet produces, so it's the form
 *   most likely to be pasted in; note its id is a share id in its own space,
 *   not the post's shortcode
 *
 * The last two redirect to the canonical form, so `fetchContent` re-checks the
 * URL it actually landed on rather than trusting the id here to be a post's.
 */
export function parseThreadsPostCode(url: URL): string | null {
  if (!THREADS_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean).map(safeDecodeURIComponent);

  // /@{handle}/post/{code}[/{slug}]
  if (
    (parts.length === 3 || parts.length === 4) &&
    parts[0].startsWith("@") &&
    parts[0].length > 1 &&
    parts[1] === "post" &&
    parts[2]
  ) {
    return parts[2];
  }

  // /t/{code} and /share/{code} — both redirect to the canonical form.
  if (parts.length === 2 && (parts[0] === "t" || parts[0] === "share") && parts[1]) {
    return parts[1];
  }

  return null;
}

// ============================================================================
// Rendering (pure, unit-testable)
// ============================================================================

interface ThreadsOpenGraph {
  title: string | null;
  description: string | null;
  image: string | null;
  /** `twitter:card` — see {@link postImageUrl} for why this decides the image. */
  card: string | null;
}

function extractThreadsOpenGraph(html: string): ThreadsOpenGraph {
  let title: string | null = null;
  let description: string | null = null;
  let image: string | null = null;
  let card: string | null = null;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name.toLowerCase() !== "meta") {
          return;
        }
        const property = attribs.property?.toLowerCase();
        const metaName = attribs.name?.toLowerCase();
        const content = attribs.content;
        if (!content) {
          return;
        }
        if (property === "og:title" && !title) {
          title = content;
        } else if (property === "og:description" && !description) {
          description = content;
        } else if (property === "og:image" && !image) {
          image = content;
        } else if (metaName === "twitter:card" && !card) {
          card = content;
        }
      },
    },
    { decodeEntities: true }
  );
  parser.write(html);
  parser.end();

  return { title, description, image, card };
}

/**
 * The post's attached image, or null when the post has none.
 *
 * `og:image` is always populated — with the author's **avatar** when the post
 * has no media — so it can't be rendered unconditionally without decorating
 * every text post with a profile picture. `twitter:card` is what distinguishes
 * them, and it's a documented Twitter Card semantic rather than a guess at
 * Meta's CDN path conventions: `summary_large_image` means the image *is* the
 * content, `summary` means it's a thumbnail.
 *
 * Measured over 14 live posts: all 7 `summary_large_image` posts had real post
 * media in `og:image`, and all 7 `summary` posts had the avatar. The rule is
 * deliberately one-directional — 2 of those `summary` posts (a 20-image
 * carousel, and one single-image post) *did* have media that Threads simply
 * doesn't advertise, so their images are missed. Missing an image is a much
 * cheaper mistake than captioning every text post with the author's face.
 */
function postImageUrl({ image, card }: ThreadsOpenGraph): string | null {
  if (card?.toLowerCase() !== "summary_large_image" || !image) {
    return null;
  }
  return /^https?:\/\//i.test(image) ? image : null;
}

/**
 * Pull the author out of Threads' `og:title`, which is always
 * `"Display Name (@handle) on Threads"`. Returns the name-and-handle part, or
 * the whole string if Threads ever changes the suffix.
 */
export function parseThreadsAuthor(ogTitle: string | null): string | null {
  if (!ogTitle) {
    return null;
  }
  const trimmed = ogTitle.replace(/\s+on\s+Threads\s*$/i, "").trim();
  return trimmed || null;
}

/**
 * Render a fetched Threads post page as clean article HTML plus metadata.
 * Pure, so it can be unit-tested against captured page shapes without network
 * mocking. Returns null when the page carries no post text (a deleted or
 * private post, or markup Threads has since changed), so the caller falls back
 * to normal fetching.
 */
export function renderThreadsPost(html: string, postUrl: string): SavedArticleContent | null {
  const openGraph = extractThreadsOpenGraph(html);
  const text = openGraph.description?.trim();
  if (!text) {
    return null;
  }

  const parts = [plainTextToHtml(text)];

  // Plugin HTML is a body fragment, so the save path's own `og:image` scrape
  // never sees this page — inlining the image is the only way it survives.
  const image = postImageUrl(openGraph);
  if (image) {
    // No alt text: Threads exposes none, and inventing one is worse than none.
    parts.push(`<figure><img src="${escapeHtml(image)}" alt="" loading="lazy"></figure>`);
  }

  const author = parseThreadsAuthor(openGraph.title);
  return {
    html: parts.join("\n"),
    title: socialPostTitle(text, author),
    author,
    // The post text alone, so the list summary is unaffected by the image.
    excerpt: text,
    canonicalUrl: postUrl,
  };
}

// ============================================================================
// Plugin
// ============================================================================

export const threadsPlugin: UrlPlugin = {
  name: "threads",
  hosts: [...THREADS_HOSTS],

  // Only individual post URLs; profiles, tags, and search fall through.
  matchUrl(url: URL): boolean {
    return parseThreadsPostCode(url) !== null;
  },

  capabilities: {
    savedArticle: {
      // The body is the post text we render ourselves; there is no page for
      // Readability to extract.
      skipReadability: true,
      siteName: "Threads",

      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        // Fetch what the user gave us; the short forms redirect to the
        // canonical `/@handle/post/{code}`, which serves the Open Graph tags.
        const page = await fetchPluginPage(url, "threads");
        if (!page) {
          return null;
        }

        // A deleted or invalid post redirects to the Threads home page
        // (`/?error=invalid_post`), which carries its own `og:description` —
        // "Join Threads to share ideas, ask questions…" — that would otherwise
        // be saved as the post body. Every Threads page has an `og:description`,
        // so unlike LinkedIn there is no type to gate on; confirming the page we
        // landed on is still a post is this plugin's equivalent of that gate.
        if (!parseThreadsPostCode(new URL(page.finalUrl))) {
          logger.info("Threads post URL redirected away from the post", {
            url: url.href,
            finalUrl: page.finalUrl,
          });
          return null;
        }

        const content = renderThreadsPost(page.html, page.finalUrl);
        if (!content) {
          // See the LinkedIn plugin for why these decline paths log at info.
          logger.info("Threads post page carried no post text", { url: url.href });
        }
        return content;
      },
    },
  },
};
