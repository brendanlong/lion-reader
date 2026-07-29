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
 * post.
 *
 * Unlike Threads, Readability does *not* fail on a LinkedIn post page — it
 * returns something usable. It's just consistently worse than the page's own
 * JSON-LD, in three ways measured against real posts: it picks a **commenter**
 * as the byline (on a post by Jason Feifer it returned "Jon Rosemberg"), it
 * pulls the comment thread into the body (2754 extracted characters for an
 * 834-character post), and its title is the SEO one with `| … | LinkedIn`
 * chrome rather than the post's first line. The JSON-LD is exactly the post:
 * the full body past the "see more" fold, the real author, the publish date,
 * and the attached image.
 *
 * That is why an unrecognized page returns null rather than guessing: falling
 * back to Readability is a genuinely reasonable outcome here, not a failure.
 *
 * Caveats worth knowing before debugging a bad save:
 * - Only works while the author keeps the post public; otherwise the page is an
 *   auth wall with no JSON-LD and we fall back.
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
 * `@type` values we know are the post itself, and where each keeps the body.
 *
 * Matching on the declared type — rather than sniffing for whichever entity
 * happens to carry a body-shaped field — is what keeps an unrelated entity on
 * the same page (the LinkedIn `Organization`, whose `description` is "LinkedIn
 * is the world's largest professional network") from being saved as the post.
 * A type we haven't seen falls back to normal handling instead of guessing.
 */
const POST_TYPES: Record<string, ReadonlyArray<"articleBody" | "description">> = {
  // A text post. `description` is deliberately not listed: on a link-share post
  // it describes the *shared article*, not the post.
  SocialMediaPosting: ["articleBody"],
  DiscussionForumPosting: ["articleBody"],
  // A video post carries the commentary in `description` and has no articleBody.
  VideoObject: ["description"],
};

/**
 * The subset of LinkedIn's JSON-LD we render.
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

/** SAX-scrape a post page for the entities in its JSON-LD blocks. */
function extractLinkedInJsonLd(html: string): LinkedInJsonLd[] {
  const jsonLd: LinkedInJsonLd[] = [];

  let inJsonLd = false;
  let scriptText = "";

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        if (tag === "script" && attribs.type?.toLowerCase() === "application/ld+json") {
          inJsonLd = true;
          scriptText = "";
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

  return jsonLd;
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
 * Returns null when the page carries no post entity we recognize — an auth
 * wall, a `/posts/` URL that isn't really a post, a post type we haven't seen,
 * or markup LinkedIn has since changed. The caller then falls back to normal
 * fetching, which on LinkedIn means Readability: worse than this (see the file
 * header), but a reasonable article rather than a failure.
 */
export function renderLinkedInPost(html: string, postUrl: string): SavedArticleContent | null {
  // Take the first entity whose declared @type is a post, and read the body
  // from the field that type keeps it in. Nothing is inferred from field shape,
  // so an unrelated entity on the page can't be mistaken for the post.
  let post: LinkedInJsonLd | undefined;
  let body = "";
  for (const entity of extractLinkedInJsonLd(html)) {
    const bodyFields = POST_TYPES[entity["@type"] ?? ""];
    const text = bodyFields?.map((field) => entity[field]?.trim()).find(Boolean);
    if (text) {
      post = entity;
      body = text;
      break;
    }
  }
  if (!post) {
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
