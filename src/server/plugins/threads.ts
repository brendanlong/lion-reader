import type { UrlPlugin, SavedArticleContent } from "./types";
import { socialPostTitle } from "./social-post";
import { fetchPluginPage } from "./fetch-page";
import { Parser } from "htmlparser2";
import { plainTextToHtml } from "@/server/http/html";
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
 * - **No media.** `og:image` is the author's avatar on a text post and the
 *   attached media on an image post, with nothing in the markup to tell them
 *   apart, so we render neither rather than decorating every save with an avatar.
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
}

function extractThreadsOpenGraph(html: string): ThreadsOpenGraph {
  let title: string | null = null;
  let description: string | null = null;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name.toLowerCase() !== "meta") {
          return;
        }
        const property = attribs.property?.toLowerCase();
        const content = attribs.content;
        if (!content) {
          return;
        }
        if (property === "og:title" && !title) {
          title = content;
        } else if (property === "og:description" && !description) {
          description = content;
        }
      },
    },
    { decodeEntities: true }
  );
  parser.write(html);
  parser.end();

  return { title, description };
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
  const { title: ogTitle, description } = extractThreadsOpenGraph(html);
  const text = description?.trim();
  if (!text) {
    return null;
  }

  const author = parseThreadsAuthor(ogTitle);
  return {
    html: plainTextToHtml(text),
    title: socialPostTitle(text, author),
    author,
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
