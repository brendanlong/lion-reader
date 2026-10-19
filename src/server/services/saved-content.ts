/**
 * Acquiring a saved article's content (fetching the URL through the plugins,
 * or converting an upload) and deriving the fields it's stored with. No
 * database access: storage is `saved.ts`.
 */

import { createSaxParser } from "@/server/html/sax";
import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  fetchUrl as fetchRawUrl,
  HttpFetchError,
  ContentTooLargeError,
  InvalidContentTypeError,
} from "@/server/http/fetch";
import { parseFeed } from "@/server/feed/parser";
import {
  articleContentFromAcquired,
  processArticleContent,
  type ArticleContentBundle,
} from "./article-content";
import {
  convertUploadedFile,
  titleFromFilename,
  type ConvertedUpload,
} from "@/server/file/process-upload";
import { usageLimitsConfig } from "@/server/config/env";
import { stripHtml } from "@/server/html/strip-html";
import { computeSavedArticleExcerpt } from "@/server/services/saved-excerpt";
import { logger } from "@/lib/logger";
import { errors } from "@/server/errors";
import {
  acquireArticleContent,
  normalizeSavedArticleUrl,
  UserFetchError,
  type AcquiredArticle,
} from "@/server/plugins";
import type { SaveArticleParams } from "./saved";

// ============================================================================
// Helper Functions
// ============================================================================

interface PageMetadata {
  title: string | null;
  siteName: string | null;
  author: string | null;
  imageUrl: string | null;
}

/**
 * Extracts metadata from HTML using Open Graph and meta tags.
 * Uses SAX parsing for efficiency and exits early after </head>.
 */
function extractMetadata(html: string, url: string): PageMetadata {
  const result: PageMetadata = {
    title: null,
    siteName: null,
    author: null,
    imageUrl: null,
  };

  let ogTitle: string | null = null;
  let titleText: string | null = null;
  let inTitle = false;
  let titleContent = "";

  const parser = createSaxParser(
    {
      onopentag(name, attribs) {
        const tagName = name.toLowerCase();

        if (tagName === "title") {
          inTitle = true;
          titleContent = "";
        } else if (tagName === "meta") {
          const property = attribs.property?.toLowerCase();
          const metaName = attribs.name?.toLowerCase();
          const content = attribs.content;

          if (property === "og:title" && content && !ogTitle) {
            ogTitle = content;
          } else if (property === "og:site_name" && content && !result.siteName) {
            result.siteName = content;
          } else if (property === "og:image" && content && !result.imageUrl) {
            result.imageUrl = content;
          } else if (property === "article:author" && content && !result.author) {
            result.author = content;
          } else if (metaName === "author" && content && !result.author) {
            result.author = content;
          }
        }
      },
      ontext(text) {
        if (inTitle) {
          titleContent += text;
        }
      },
      onclosetag(name) {
        const tagName = name.toLowerCase();

        if (tagName === "title") {
          inTitle = false;
          if (titleContent.trim() && !titleText) {
            titleText = titleContent.trim();
          }
        } else if (tagName === "head") {
          parser.pause();
        }
      },
    },
    { decodeEntities: true }
  );

  parser.write(html);
  parser.end();

  result.title = ogTitle || titleText;

  if (result.imageUrl && !result.imageUrl.startsWith("http")) {
    try {
      result.imageUrl = new URL(result.imageUrl, url).href;
    } catch {
      result.imageUrl = null;
    }
  }

  return result;
}

/**
 * Generates a SHA-256 content hash for saved article.
 * Used for narration deduplication.
 */
export function generateContentHash(title: string | null, content: string | null): string {
  const titleStr = title ?? "";
  const contentStr = content ?? "";
  const hashInput = `${titleStr}\n${contentStr}`;
  return createHash("sha256").update(hashInput, "utf8").digest("hex");
}

/**
 * Reserved-TLD base URL for uploaded content, which has no real origin. Relative
 * URLs in uploads resolve against this instead of Lion Reader's own domain, so a
 * stray relative link becomes an obviously-broken external URL rather than one
 * that silently points back into the app. `.invalid` never resolves (RFC 6761).
 */
const UPLOAD_BASE_URL = "https://uploaded.invalid/";

/** Caller-supplied hints that outrank (title) or backstop (filename) extraction. */
interface ArticleFieldHints {
  /** Explicit caller-provided title — highest precedence. */
  providedTitle?: string | null;
  /** Explicit caller-provided author — highest precedence. */
  providedAuthor?: string | null;
  /** Explicit caller-provided excerpt/summary — highest precedence. */
  providedExcerpt?: string | null;
  /** Upload filename, used only as a last-resort title (below Readability). */
  filename?: string | null;
  /** Provided site name (uploads: "Uploaded Document", etc.). */
  siteName?: string | null;
}

/** The stored article fields buildArticleFields derives, plus quality-guard text. */
export interface BuiltArticleFields {
  title: string | null;
  author: string | null;
  siteName: string | null;
  contentOriginal: string;
  contentCleaned: string | null;
  summary: string | null;
  imageUrl: string | null;
  contentHash: string;
  /** Plain text of the new content, for the refetch quality guard. */
  newTextContent: string;
}

/**
 * Turn an acquired content bundle into the stored article fields — shared by the
 * URL-save path and the file/Markdown upload paths, so both derive title, author,
 * site name, excerpt, cleaned content, and image identically. The only thing that
 * differs between "save" and "upload" is how the bundle was acquired (fetch vs.
 * file conversion) and that uploads carry a null URL.
 *
 * Field precedence:
 *  - title:  provided → plugin / Markdown frontmatter / docx core.xml → Readability → OG or `<title>` → filename
 *  - author: provided → plugin / frontmatter / docx core.xml → Readability byline → OG/meta author
 *  - excerpt: see {@link computeSavedArticleExcerpt} (provided → plugin excerpt → source metadata → cleaned → plugin/pre-cleaned HTML)
 */
export async function buildArticleFields(
  bundle: ArticleContentBundle,
  hints: ArticleFieldHints = {},
  // Uploads are trusted user content, so they pass a lower minCleanedLength than
  // a web fetch (where a short extraction usually means a failed JS-heavy page).
  {
    keepRelativeUrls = false,
    ...cleanOptions
  }: { minCleanedLength?: number; keepRelativeUrls?: boolean } = {}
): Promise<BuiltArticleFields> {
  const { html, contentUrl, pluginContent, preCleanedContent } = bundle;
  // Uploads have no origin; a guaranteed-broken base keeps relative URLs from
  // resolving against Lion Reader itself.
  const baseUrl = contentUrl ?? UPLOAD_BASE_URL;

  const metadata = extractMetadata(html, baseUrl);
  const {
    contentOriginal,
    contentCleaned,
    readability: cleaned,
  } = await processArticleContent(bundle, keepRelativeUrls ? null : baseUrl, {
    offload: true,
    ...cleanOptions,
  });

  // Precedence: explicit caller value → plugin / Markdown frontmatter / docx
  // core.xml → Readability → raw Open Graph/<title>/meta scrape → filename (title only).
  //
  // Readability sits above the raw `metadata` scrape (both for title and author)
  // because Readability is itself a "source-specific" extractor that mostly reads
  // the same Open Graph/meta tags — but when it and the raw scrape disagree, we
  // trust Readability to have done better (e.g. stripping a " | Site Name" title
  // suffix, or picking the real byline over a generic `meta[name=author]`). It
  // only returns a value when it also extracted the body, so the raw `metadata`
  // scrape stays just below it as the fallback that survives a failed extraction
  // (short/unparseable page). This ordering is HTML-only in practice: Readability
  // is skipped for Markdown (frontmatter wins) and for plugins that opt out
  // (`cleaned` is null), so those correctly prefer their own declared metadata.
  // dom_smoothie cleans up the title in some cases (e.g. stripping a
  // " | Site Name" suffix) that our simpler raw scrape doesn't, so we prefer its
  // output when it exists
  const title =
    hints.providedTitle ||
    pluginContent?.title ||
    preCleanedContent?.title ||
    cleaned?.title ||
    metadata.title ||
    (hints.filename ? titleFromFilename(hints.filename) || null : null) ||
    null;
  const author =
    hints.providedAuthor ||
    pluginContent?.author ||
    preCleanedContent?.author ||
    cleaned?.byline ||
    metadata.author ||
    null;
  const siteName = hints.siteName || pluginContent?.siteName || metadata.siteName || null;

  const summary = computeSavedArticleExcerpt({
    providedExcerpt: hints.providedExcerpt,
    preCleanedContent,
    cleaned,
    pluginContent,
    html,
  });

  const contentHash = generateContentHash(title, contentCleaned || html);

  // Plain text for the refetch quality guard: prefer the raw plugin body, else
  // Readability's text, else the raw HTML stripped.
  const newTextContent = pluginContent
    ? stripHtml(pluginContent.html)
    : cleaned
      ? cleaned.textContent
      : stripHtml(html);

  return {
    title,
    author,
    siteName,
    contentOriginal,
    contentCleaned,
    summary,
    imageUrl: metadata.imageUrl,
    contentHash,
    newTextContent,
  };
}

/**
 * Content types that are unambiguously a feed. When a page fetch is rejected
 * with one of these, we can route to Subscribe without a second fetch.
 */
const UNAMBIGUOUS_FEED_CONTENT_TYPES = [
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
];

/**
 * Decide whether a URL that failed a page fetch on its content type is actually
 * a feed (so the caller can route the user to Subscribe instead of failing the
 * save). Unambiguous feed content types short-circuit; ambiguous XML/JSON
 * (`text/xml`, `application/xml`, `application/json`) is confirmed by fetching
 * and actually parsing it as a feed — so a sitemap (`<urlset>`) or a plain JSON
 * API (no JSON Feed `version`/`items`) is correctly rejected rather than
 * misrouted to Subscribe. Only reached on the rare feed-rejection path, so the
 * common article save stays a single fetch.
 */
async function urlIsDirectFeed(url: string, contentType: string): Promise<boolean> {
  const normalized = contentType.toLowerCase();
  if (UNAMBIGUOUS_FEED_CONTENT_TYPES.some((type) => normalized.includes(type))) {
    return true;
  }
  try {
    const { text } = await fetchRawUrl(url);
    // parseFeed throws for unknown formats and for structurally-invalid feeds
    // (a sitemap, a plain JSON object, etc.) — exactly what we want to exclude.
    parseFeed(text);
    return true;
  } catch {
    // Not fetchable or not a real feed: treat as not-a-feed and let the original
    // fetch error surface.
    return false;
  }
}

/**
 * Acquire the article HTML for a save. Precedence: provided HTML > plugin >
 * plugin with the user's credentials (when the caller opts in via `userAuth`) >
 * plain HTML fetch. Enforces maxSavedArticleSizeBytes on every path.
 */
export async function acquireSavedArticleContent(
  userId: string,
  params: Pick<SaveArticleParams, "url" | "html" | "userAuth">
): Promise<ArticleContentBundle & { contentUrl: string }> {
  const maxSize = usageLimitsConfig.maxSavedArticleSizeBytes;

  if (params.html) {
    if (Buffer.byteLength(params.html, "utf8") > maxSize) {
      throw errors.contentTooLarge("Article", maxSize);
    }
    logger.debug("Using provided HTML for saved article", {
      url: params.url,
      htmlLength: params.html.length,
    });
    return {
      html: params.html,
      contentUrl: params.url,
      pluginContent: null,
      preCleanedContent: null,
    };
  }

  // Scope the try to the fetch itself. Every failure the fetch can raise — an
  // upstream error status, a network/DNS failure, a timeout, an SSRF block, an
  // unusable content type — is a problem with the user-provided URL, not a bug
  // in our server, so it maps to the client-facing SAVED_ARTICLE_FETCH_ERROR (a
  // 4xx that isn't reported to Sentry). Post-fetch processing (Markdown
  // conversion, Readability upstream) is deliberately OUTSIDE this catch: a
  // failure there is our bug and must surface as a 500 → Sentry, not be masked
  // as a "fetch error". A plugin's fetch with the user's credentials fails
  // already classified (a consent prompt) or with our bug, so it skips the
  // mapping too.
  const fetchUrl = normalizeSavedArticleUrl(params.url);
  let acquired: AcquiredArticle;
  try {
    acquired = await acquireArticleContent(fetchUrl, {
      asUser: params.userAuth ? { userId, authMode: params.userAuth } : undefined,
    });
  } catch (error) {
    if (error instanceof UserFetchError) {
      throw error.cause;
    }
    if (error instanceof TRPCError) {
      throw error;
    }
    logger.warn("Failed to fetch URL for saved article", {
      url: fetchUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof ContentTooLargeError) {
      throw errors.contentTooLarge("Article", maxSize);
    }
    if (error instanceof HttpFetchError) {
      if (error.isRateLimited()) {
        throw errors.upstreamRateLimited(fetchUrl);
      }
      if (error.isBlocked()) {
        throw errors.siteBlocked(fetchUrl, error.status);
      }
    }
    // A feed shared to the PWA lands here (feeds are served as XML/JSON, which
    // the page fetch rejects). If it's really a feed, signal the caller to route
    // to Subscribe instead of failing the save.
    if (error instanceof InvalidContentTypeError) {
      if (await urlIsDirectFeed(fetchUrl, error.contentType)) {
        throw errors.urlIsFeed(fetchUrl);
      }
    }
    throw errors.savedArticleFetchError(
      fetchUrl,
      error instanceof Error ? error.message : "Unknown error"
    );
  }

  return articleContentFromAcquired(acquired, { offload: true });
}

/**
 * Converts an uploaded file, reporting a file it can't read as the user's
 * error. An error that already knows what it is keeps its own code: Markdown
 * busting its byte budget is `CONTENT_TOO_LARGE` (#1431), not a bad file.
 */
export async function convertUpload(file: Buffer, filename: string): Promise<ConvertedUpload> {
  try {
    return await convertUploadedFile(file, filename);
  } catch (error) {
    logger.warn("Failed to convert uploaded file", {
      filename,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof TRPCError) throw error;
    const message = error instanceof Error ? error.message : "Unknown error";
    throw errors.validation(`Failed to process file: ${message}`);
  }
}
