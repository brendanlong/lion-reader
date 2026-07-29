import type { UrlPlugin, SavedArticleContent } from "./types";
import { socialPostTitle } from "./social-post";
import { Parser } from "htmlparser2";
import { plainTextToHtml } from "@/server/http/html";
import { fetchHtmlPage } from "@/server/http/fetch";
import { logger } from "@/lib/logger";

/**
 * Threads plugin (saved articles only).
 *
 * The official Threads API reads only the authenticated user's own posts;
 * reading anyone else's public post needs the Keyword Search API, which
 * requires Meta App Review plus business verification. The token-free
 * `graph.threads.net/oembed` endpoint returns only the `<blockquote>` shell
 * that `embed.js` hydrates client-side — no post text. And the post page is a
 * JS app that yields nothing to Readability.
 *
 * What is available is Open Graph: a Threads post page serves the complete post
 * text in `og:description` (the posts are short, so it isn't elided the way
 * `twitter:description` is) and the author in `og:title`. That's what this
 * plugin renders.
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
 * Parse a Threads post URL into its shortcode. Handles the canonical
 * `/@handle/post/{code}` form (with or without the SEO slug Threads appends),
 * and the `/t/{code}` short permalink its embeds use.
 */
export function parseThreadsPostCode(url: URL): string | null {
  if (!THREADS_HOSTS.has(url.hostname.toLowerCase())) {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

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

  // /t/{code} — the short permalink form used in embeds and share sheets.
  if (parts.length === 2 && parts[0] === "t" && parts[1]) {
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
      onclosetag(name) {
        if (name.toLowerCase() === "head") {
          parser.pause();
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
        // Fetch what the user gave us; `/t/{code}` redirects to the canonical
        // `/@handle/post/{code}`, and both serve the same Open Graph tags.
        let html: string;
        let finalUrl: string;
        try {
          const result = await fetchHtmlPage(url.href);
          if (result.isMarkdown) {
            return null;
          }
          html = result.content;
          finalUrl = result.finalUrl;
        } catch (error) {
          logger.warn("Failed to fetch Threads post page", {
            url: url.href,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }

        const content = renderThreadsPost(html, finalUrl);
        if (!content) {
          logger.debug("Threads post page carried no post text", { url: url.href });
        }
        return content;
      },
    },
  },
};
