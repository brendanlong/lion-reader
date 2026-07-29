import type { UrlPlugin, SavedArticleContent } from "./types";
import { socialPostTitle } from "./social-post";
import { Parser } from "htmlparser2";
import { escapeHtml, plainTextToHtml } from "@/server/http/html";
import { fetchHtmlPage } from "@/server/http/fetch";
import { logger } from "@/lib/logger";

/**
 * LinkedIn plugin (saved articles only).
 *
 * LinkedIn has no public read API — open API access ended in 2015 and the
 * Community Management API is partner-gated and scoped to content the
 * authenticated member owns, so there is nothing to call for someone else's
 * post. Saving a post URL therefore ran Readability over a login-walled JS page
 * and stored a sign-up prompt.
 *
 * What LinkedIn *does* serve to a logged-out client is a JSON-LD
 * `SocialMediaPosting` (or `VideoObject` for a video post) carrying the full
 * post body past the "see more" fold, the author, the publish date, and the
 * attached image. That's the richest thing available without auth, so this
 * plugin fetches the public post page and renders that.
 *
 * Caveats worth knowing before debugging a bad save:
 * - Only works while the author keeps the post public; otherwise the page is an
 *   auth wall with no JSON-LD and we return null to fall back to normal handling.
 * - LinkedIn is well known for serving HTTP 999 / auth walls to datacenter IP
 *   ranges, so this can degrade in production even when it works locally. The
 *   fetch failing is handled the same as unusable markup: fall back, don't throw.
 * - `linkedin.com/robots.txt` is `Disallow: /` for a generic user agent. This is
 *   a user-initiated single-post fetch on save, not crawling, but don't extend it
 *   into anything that walks profiles or feeds.
 */

// ============================================================================
// URL parsing
// ============================================================================

/**
 * A post's activity URN (`urn:li:activity:1234…`). Both public URL forms carry
 * one, and it's the id LinkedIn's own embed/permalink URLs are keyed on.
 */
export function parseLinkedInPostUrn(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && host !== "www.linkedin.com" && host !== "m.linkedin.com") {
    return null;
  }

  // Share URL: /posts/{author-slug}_{title-slug}-activity-{id}-{code}
  const postsMatch = /^\/posts\/[^/]*-activity-(\d+)-[^/]*\/?$/.exec(url.pathname);
  if (postsMatch) {
    return `urn:li:activity:${postsMatch[1]}`;
  }

  // Permalink URL: /feed/update/urn:li:activity:{id} (also share/ugcPost URNs,
  // which LinkedIn's own "copy link to post" produces for some post types).
  const feedMatch = /^\/feed\/update\/(urn:li:(?:activity|share|ugcPost):\d+)\/?$/.exec(
    decodeURIComponent(url.pathname)
  );
  if (feedMatch) {
    return feedMatch[1];
  }

  return null;
}

// ============================================================================
// JSON-LD extraction
// ============================================================================

/**
 * The subset of LinkedIn's JSON-LD we render. A text post is a
 * `SocialMediaPosting` with `articleBody`; a video post is a `VideoObject` whose
 * commentary is in `description`. We key off the field shape rather than
 * `@type` so a type we haven't seen still works if it carries a body.
 */
interface LinkedInJsonLd {
  "@type"?: string;
  headline?: string;
  articleBody?: string;
  description?: string;
  datePublished?: string;
  author?: { name?: string; url?: string };
  creator?: { name?: string; url?: string };
  image?: { url?: string } | { url?: string }[];
  thumbnailUrl?: string;
}

/** What we scrape out of a post page in one pass. */
interface LinkedInPageData {
  jsonLd: LinkedInJsonLd[];
  ogDescription: string | null;
}

/**
 * SAX-scrape a post page for its JSON-LD blocks and `og:description`. The two
 * are complements, not alternatives: a text post has JSON-LD `articleBody` and
 * no `og:description`, while a link-share post's `og:description` describes the
 * *shared article* rather than the post.
 */
export function extractLinkedInPageData(html: string): LinkedInPageData {
  const jsonLd: LinkedInJsonLd[] = [];
  let ogDescription: string | null = null;

  let inJsonLd = false;
  let scriptText = "";

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        if (tag === "script" && attribs.type?.toLowerCase() === "application/ld+json") {
          inJsonLd = true;
          scriptText = "";
        } else if (tag === "meta") {
          const property = attribs.property?.toLowerCase();
          if (property === "og:description" && attribs.content && !ogDescription) {
            ogDescription = attribs.content;
          }
        }
      },
      ontext(text) {
        if (inJsonLd) {
          scriptText += text;
        }
      },
      onclosetag(name) {
        if (name.toLowerCase() !== "script" || !inJsonLd) {
          return;
        }
        inJsonLd = false;
        try {
          const parsed: unknown = JSON.parse(scriptText);
          // A `@graph` wrapper or a bare array both show up in the wild.
          const entries = Array.isArray(parsed) ? parsed : [parsed];
          for (const entry of entries) {
            if (entry && typeof entry === "object") {
              jsonLd.push(entry as LinkedInJsonLd);
            }
          }
        } catch {
          // Malformed JSON-LD is not worth failing the save over.
        }
      },
    },
    { decodeEntities: true }
  );
  parser.write(html);
  parser.end();

  return { jsonLd, ogDescription };
}

/**
 * Strip the boilerplate LinkedIn appends to `og:description`
 * (`… | 21 comments on LinkedIn`), which is engagement chrome rather than part
 * of the post.
 */
function stripOgDescriptionSuffix(description: string): string {
  return description.replace(/\s*\|\s*(?:\d+\s+comments?\s+on\s+)?LinkedIn\s*$/i, "").trim();
}

function firstImageUrl(image: LinkedInJsonLd["image"]): string | null {
  const first = Array.isArray(image) ? image[0] : image;
  const url = first?.url;
  return url && /^https?:\/\//i.test(url) ? url : null;
}

// ============================================================================
// Rendering (pure, unit-testable)
// ============================================================================

/**
 * Render a fetched LinkedIn post page as clean article HTML plus metadata.
 * Pure — `fetchContent` supplies the HTML — so it can be unit-tested against
 * captured page shapes without network mocking.
 *
 * Returns null when the page carries no usable post body (an auth wall, a
 * `/posts/` URL that isn't really a post, markup LinkedIn has since changed),
 * which makes the caller fall back to normal fetching.
 */
export function renderLinkedInPost(html: string, postUrl: string): SavedArticleContent | null {
  const { jsonLd, ogDescription } = extractLinkedInPageData(html);

  // First block that actually carries a post body; a page can also contain
  // unrelated JSON-LD (breadcrumbs, the organization).
  const post = jsonLd.find((entry) => entry.articleBody?.trim() || entry.description?.trim());
  const body =
    post?.articleBody?.trim() ||
    post?.description?.trim() ||
    (ogDescription ? stripOgDescriptionSuffix(ogDescription) : "");
  if (!body) {
    return null;
  }

  const person = post?.author ?? post?.creator;
  const author = person?.name?.trim() || null;

  const parts = [plainTextToHtml(body)];

  // The post's attached image (or the shared link's thumbnail). Plugin HTML is a
  // body fragment, so the save path's `og:image` scrape never sees this page —
  // inlining it is the only way the image survives the save.
  const image = firstImageUrl(post?.image) ?? null;
  if (image) {
    parts.push(`<figure><img src="${escapeHtml(image)}" alt="" loading="lazy"></figure>`);
  } else if (post?.thumbnailUrl && /^https?:\/\//i.test(post.thumbnailUrl)) {
    // A video post: the media itself is a streaming manifest a bare <video>
    // can't play, so link back to the post behind its poster frame.
    parts.push(
      `<figure><a href="${escapeHtml(postUrl)}">` +
        `<img src="${escapeHtml(post.thumbnailUrl)}" alt="" loading="lazy">` +
        `<strong>Watch video on LinkedIn</strong></a></figure>`
    );
  }

  const published = post?.datePublished ? new Date(post.datePublished) : null;

  return {
    html: parts.filter(Boolean).join("\n"),
    // LinkedIn's own `headline` is a cleaned-up first line of the post; fall
    // back to deriving one the way the other social plugins do.
    title: post?.headline?.trim() || socialPostTitle(body, author),
    author,
    publishedAt: published && !Number.isNaN(published.getTime()) ? published : null,
    canonicalUrl: postUrl,
  };
}

// ============================================================================
// Plugin
// ============================================================================

export const linkedInPlugin: UrlPlugin = {
  name: "linkedin",
  hosts: ["linkedin.com", "www.linkedin.com", "m.linkedin.com"],

  // Only individual post URLs. Profiles, company pages, jobs, and `/pulse/`
  // long-form articles fall through to normal handling.
  matchUrl(url: URL): boolean {
    return parseLinkedInPostUrn(url) !== null;
  },

  capabilities: {
    savedArticle: {
      // We build the body ourselves from JSON-LD; there is no page for
      // Readability to extract (and on the raw page it extracts the auth wall).
      skipReadability: true,
      siteName: "LinkedIn",

      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        // Both public URL forms serve the same logged-out page with the same
        // JSON-LD, so fetch what the user gave us rather than reconstructing it.
        let html: string;
        try {
          const result = await fetchHtmlPage(url.href);
          if (result.isMarkdown) {
            return null;
          }
          html = result.content;
        } catch (error) {
          logger.warn("Failed to fetch LinkedIn post page", {
            url: url.href,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        }

        const content = renderLinkedInPost(html, url.href);
        if (!content) {
          logger.debug("LinkedIn post page carried no usable body", { url: url.href });
        }
        return content;
      },
    },
  },
};
