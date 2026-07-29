import type { UrlPlugin, SavedArticleContent } from "./types";
import { socialPostTitle } from "./social-post";
import { fetchPluginPage } from "./fetch-page";
import { Parser } from "htmlparser2";
import { escapeHtml, plainTextToHtml } from "@/server/http/html";
import { safeDecodeURIComponent } from "@/lib/url";
import { logger } from "@/lib/logger";

/**
 * LinkedIn plugin (saved articles only).
 *
 * LinkedIn has no public read API — open API access ended in 2015 and the
 * Community Management API is partner-gated and scoped to content the
 * authenticated member owns, so there is nothing to call for someone else's
 * post. Without this plugin a post URL goes to Readability, which extracts the
 * login wall.
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
    safeDecodeURIComponent(url.pathname)
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
interface LinkedInPerson {
  name?: string;
  url?: string;
}

/** schema.org lets a value be a single item or an array of them, everywhere. */
type OneOrMany<T> = T | T[];

/** An `ImageObject`, or the bare URL string schema.org also permits. */
type LinkedInImage = string | { url?: string };

interface LinkedInJsonLd {
  "@type"?: string;
  headline?: string;
  articleBody?: string;
  description?: string;
  datePublished?: string;
  author?: OneOrMany<LinkedInPerson>;
  creator?: OneOrMany<LinkedInPerson>;
  image?: OneOrMany<LinkedInImage>;
  thumbnailUrl?: string;
  /** Some schema.org emitters nest the real entities under a `@graph`. */
  "@graph"?: unknown;
}

/** What we scrape out of a post page in one pass. */
interface LinkedInPageData {
  jsonLd: LinkedInJsonLd[];
  ogDescription: string | null;
}

/**
 * Flatten one parsed JSON-LD document into the entity objects it contains,
 * unwrapping the two containers schema.org allows: a top-level array, and a
 * `@graph` array.
 */
function flattenJsonLd(parsed: unknown): LinkedInJsonLd[] {
  const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
  const entities: LinkedInJsonLd[] = [];
  for (const item of queue) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entity = item as LinkedInJsonLd;
    // A `@graph` wrapper carries no body itself; only its members matter.
    if (Array.isArray(entity["@graph"])) {
      queue.push(...entity["@graph"]);
      continue;
    }
    entities.push(entity);
  }
  return entities;
}

/**
 * SAX-scrape a post page for its JSON-LD entities and `og:description`. The two
 * are complements, not alternatives: a text post carries JSON-LD `articleBody`
 * and no `og:description` at all, while a link-share post's `og:description`
 * describes the *shared article* — which is why it is only ever a last resort.
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
          jsonLd.push(...flattenJsonLd(JSON.parse(scriptText)));
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

function isHttpUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

/** Coerce schema.org's single-or-array shape to an array. */
function toArray<T>(value: OneOrMany<T> | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** First image with a usable http(s) URL, skipping any that aren't. */
function firstImageUrl(image: LinkedInJsonLd["image"]): string | null {
  for (const entry of toArray(image)) {
    const url = typeof entry === "string" ? entry : entry?.url;
    if (isHttpUrl(url)) {
      return url;
    }
  }
  return null;
}

/** First named author/creator. */
function firstAuthorName(post: LinkedInJsonLd | undefined): string | null {
  for (const person of [...toArray(post?.author), ...toArray(post?.creator)]) {
    const name = person?.name?.trim();
    if (name) {
      return name;
    }
  }
  return null;
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

  // `articleBody` is unambiguously the post, so prefer any entity that has one
  // over any entity that only has a `description`. A page can also carry
  // unrelated JSON-LD (breadcrumbs, the LinkedIn `Organization`), and an
  // `Organization`'s boilerplate `description` would otherwise win on ordering
  // alone and be saved as the post body.
  const post =
    jsonLd.find((entity) => entity.articleBody?.trim()) ??
    jsonLd.find((entity) => entity.description?.trim());
  const body =
    post?.articleBody?.trim() ||
    post?.description?.trim() ||
    (ogDescription ? stripOgDescriptionSuffix(ogDescription) : "");
  if (!body) {
    return null;
  }

  const author = firstAuthorName(post);

  const parts = [plainTextToHtml(body)];

  // The post's attached image (or the shared link's thumbnail). Plugin HTML is a
  // body fragment, so the save path's `og:image` scrape never sees this page —
  // inlining it is the only way the image survives the save.
  const image = firstImageUrl(post?.image) ?? null;
  if (image) {
    parts.push(`<figure><img src="${escapeHtml(image)}" alt="" loading="lazy"></figure>`);
  } else if (isHttpUrl(post?.thumbnailUrl)) {
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
    // LinkedIn's own `headline` is a cleaned-up first line of the post, but
    // it's remote-controlled and unbounded — run it through the same eliding
    // the other social plugins use rather than storing it raw.
    title: socialPostTitle(post?.headline?.trim() || body, author),
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
        const page = await fetchPluginPage(url, "linkedin");
        if (!page) {
          return null;
        }

        const content = renderLinkedInPost(page.html, page.finalUrl);
        if (!content) {
          logger.debug("LinkedIn post page carried no usable body", { url: url.href });
        }
        return content;
      },
    },
  },
};
