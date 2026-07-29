import type { UrlPlugin, SavedArticleContent } from "./types";
import { socialPostTitle } from "./social-post";
import { fetchPluginPage } from "./fetch-page";
import { Parser } from "htmlparser2";
import { z } from "zod";
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
 * JSON-LD is `unknown` at runtime: it is remote JSON, so every field may be
 * absent, the wrong type, or — since schema.org permits a single value or an
 * array of them **anywhere** — wrapped in an array. These schemas do the
 * narrowing so the render path never has to, and a value of the wrong shape is
 * dropped rather than crashing the save.
 */
const jsonLdText = z.string().trim().min(1);
const jsonLdHttpUrl = jsonLdText.regex(/^https?:\/\//i);
/** A `Person`, or the bare name string schema.org also permits. */
const jsonLdPersonName = z.union([
  jsonLdText,
  z.object({ name: jsonLdText }).transform((p) => p.name),
]);
/** An `ImageObject`, or the bare URL string schema.org also permits. */
const jsonLdImageUrl = z.union([
  jsonLdHttpUrl,
  z.object({ url: jsonLdHttpUrl }).transform((i) => i.url),
]);

/**
 * Parse the first of `value`'s candidates that matches, treating a lone value
 * and an array of values identically. Returns null when none match, so an
 * unusable entry (a `javascript:` image URL) is skipped rather than accepted or
 * fatal.
 */
function firstMatching<T>(schema: z.ZodType<T>, value: unknown): T | null {
  for (const candidate of Array.isArray(value) ? value : [value]) {
    const parsed = schema.safeParse(candidate);
    if (parsed.success) {
      return parsed.data;
    }
  }
  return null;
}

/** A JSON-LD entity, before any of its fields have been validated. */
type JsonLdEntity = Record<string, unknown>;

/**
 * The `@type` values that are the post itself, the field each keeps its body
 * in, and — significantly — the order to prefer them in.
 *
 * Matching the declared type, rather than sniffing for whichever entity happens
 * to carry a body-shaped field, is what keeps an unrelated entity on the same
 * page (the LinkedIn `Organization`, whose `description` is "LinkedIn is the
 * world's largest professional network") from being saved as the post. A type
 * not listed here is declined rather than guessed at.
 *
 * The order matters because a page can carry more than one *post-typed* entity:
 * a post that shares a video has both a `SocialMediaPosting` (the member's own
 * commentary) and a `VideoObject` (the shared media). Document order doesn't
 * reliably put the post first, so the post's own types outrank the media's.
 */
const POST_TYPES = [
  // `description` is deliberately not read for these: on a link-share post it
  // describes the *shared article*, not the post.
  { type: "SocialMediaPosting", bodyField: "articleBody" },
  { type: "DiscussionForumPosting", bodyField: "articleBody" },
  // A video post carries the commentary in `description` and has no articleBody.
  { type: "VideoObject", bodyField: "description" },
] as const;

/**
 * Flatten one parsed JSON-LD document into the entity objects it contains,
 * unwrapping the two containers schema.org allows: a top-level array, and a
 * `@graph` array.
 */
function flattenJsonLd(parsed: unknown): JsonLdEntity[] {
  const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
  const entities: JsonLdEntity[] = [];
  for (const item of queue) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const entity = item as JsonLdEntity;
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
function extractLinkedInJsonLd(html: string): JsonLdEntity[] {
  const jsonLd: JsonLdEntity[] = [];

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

/**
 * Find the entity that is the post, in {@link POST_TYPES} priority order, along
 * with its body text. Returns null when the page declares no post we recognize.
 */
function findPostEntity(entities: JsonLdEntity[]): { post: JsonLdEntity; body: string } | null {
  for (const { type, bodyField } of POST_TYPES) {
    for (const post of entities) {
      if (firstMatching(z.literal(type), post["@type"]) === null) {
        continue;
      }
      const body = firstMatching(jsonLdText, post[bodyField]);
      if (body) {
        return { post, body };
      }
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
  const found = findPostEntity(extractLinkedInJsonLd(html));
  if (!found) {
    return null;
  }
  const { post, body } = found;

  const author =
    firstMatching(jsonLdPersonName, post.author) ?? firstMatching(jsonLdPersonName, post.creator);

  const parts = [plainTextToHtml(body)];

  // The post's attached image (or the shared link's thumbnail). Plugin HTML is a
  // body fragment, so the save path's `og:image` scrape never sees this page —
  // inlining it is the only way the image survives the save.
  const image = firstMatching(jsonLdImageUrl, post.image);
  const thumbnail = firstMatching(jsonLdHttpUrl, post.thumbnailUrl);
  if (image) {
    parts.push(`<figure><img src="${escapeHtml(image)}" alt="" loading="lazy"></figure>`);
  } else if (thumbnail) {
    // A video post: the media itself is a streaming manifest a bare <video>
    // can't play, so link back to the post behind its poster frame.
    parts.push(
      `<figure><a href="${escapeHtml(postUrl)}">` +
        `<img src="${escapeHtml(thumbnail)}" alt="" loading="lazy">` +
        `<strong>Watch video on LinkedIn</strong></a></figure>`
    );
  }

  const publishedText = firstMatching(jsonLdText, post.datePublished);
  const published = publishedText ? new Date(publishedText) : null;

  return {
    html: parts.join("\n"),
    // LinkedIn's own `headline` is a cleaned-up first line of the post, but
    // it's remote-controlled and unbounded — run it through the same eliding
    // the other social plugins use rather than storing it raw.
    title: socialPostTitle(firstMatching(jsonLdText, post.headline) ?? body, author),
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
