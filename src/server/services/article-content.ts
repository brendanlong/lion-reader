/**
 * Turns acquired article content into the stored original/cleaned HTML pair.
 *
 * The one pipeline behind saving an article (URL save and file/Markdown upload)
 * and fetching an entry's full content, so the two can't drift on when
 * Readability runs or which copy gets its URLs absolutized.
 */

import { absolutizeUrls, cleanContent, cleanContentAsync } from "@/server/feed/content-cleaner";
import type { CleanedContent } from "@/server/feed/content-cleaner";
import { processMarkdown } from "@/server/markdown";
import type { AcquiredArticle } from "@/server/plugins";

/**
 * A unit of acquired content, however it was obtained: fetched from a URL
 * ({@link articleContentFromAcquired}) or converted from an uploaded file.
 */
export interface ArticleContentBundle {
  /** Raw content HTML (stored, absolutized, as the original). */
  html: string;
  /** Base URL for metadata + relative-URL resolution; null for uploads (no origin). */
  contentUrl: string | null;
  /** Plugin-supplied content that bypasses normal metadata/Readability sources. */
  pluginContent: {
    html: string;
    title?: string | null;
    author?: string | null;
    /** Plugin-supplied excerpt (e.g. arXiv abstract page); preferred over Readability's. */
    excerpt?: string | null;
    siteName?: string;
    skipReadability?: boolean;
  } | null;
  /**
   * Set when `html` is already clean, so Readability is skipped: Markdown
   * (frontmatter title/summary/author) or a `.docx` (mammoth body +
   * `docProps/core.xml` metadata). Null when Readability should run.
   */
  preCleanedContent: {
    title: string | null;
    summary: string | null;
    author: string | null;
  } | null;
}

/**
 * Map what `acquireArticleContent` fetched to a bundle, rendering Markdown.
 * `contentUrl` is where the content came from (after redirects), or the
 * plugin's canonical URL.
 *
 * @param options.offload - Render Markdown on the libuv thread pool (request
 *   paths); background jobs pass false.
 */
export async function articleContentFromAcquired(
  acquired: AcquiredArticle,
  options: { offload: boolean }
): Promise<ArticleContentBundle & { contentUrl: string }> {
  if (acquired.kind === "plugin") {
    const { content } = acquired;
    return {
      html: content.html,
      contentUrl: content.canonicalUrl || acquired.baseUrl,
      pluginContent: {
        html: content.html,
        title: content.title,
        author: content.author,
        excerpt: content.excerpt,
        siteName: acquired.siteName,
        skipReadability: acquired.skipReadability,
      },
      preCleanedContent: null,
    };
  }

  // We request HTML, not Markdown (#1280), so this is a fallback for a server
  // that returned Markdown anyway (e.g. a raw `.md` URL). Its body is the
  // content itself, and once flattened to Markdown the DOM structure
  // Readability needs to separate chrome from content is gone.
  if (acquired.isMarkdown) {
    const markdown = await processMarkdown(acquired.content, { offload: options.offload });
    return {
      html: markdown.html,
      contentUrl: acquired.finalUrl,
      pluginContent: null,
      preCleanedContent: markdown,
    };
  }

  return {
    html: acquired.content,
    contentUrl: acquired.finalUrl,
    pluginContent: null,
    preCleanedContent: null,
  };
}

/** The stored HTML pair, plus Readability's metadata when it ran. */
export interface ProcessedArticleContent {
  /** The acquired HTML with absolute URLs ("show original" displays it). */
  contentOriginal: string;
  /**
   * The article body with absolute URLs: Readability's extraction, or the
   * content itself when it is already clean (pre-cleaned, or a plugin's).
   * Null only when Readability failed on a generic page; what to do then is
   * the caller's decision.
   */
  contentCleaned: string | null;
  /** Readability's result, when it ran and succeeded. */
  readability: CleanedContent | null;
}

/**
 * Run Readability unless the content is already clean (pre-cleaned, or a
 * plugin's with `skipReadability`), and absolutize relative URLs in both
 * stored copies against `baseUrl` (null leaves them as written). Readability absolutizes its own output;
 * nothing downstream (the Markdown renderer, the sanitizer) does, so a
 * relative URL left here would resolve against Lion Reader's origin.
 *
 * A plugin's content is the article even when Readability can't improve on it,
 * so a failed extraction falls back to it.
 *
 * @param options.offload - Run Readability on the libuv thread pool (request
 *   paths); background jobs pass false.
 * @param options.minCleanedLength - Passed to Readability (uploads, being
 *   trusted user content, accept a shorter extraction than a web page).
 */
export async function processArticleContent(
  bundle: ArticleContentBundle,
  baseUrl: string | null,
  options: { offload: boolean; minCleanedLength?: number }
): Promise<ProcessedArticleContent> {
  const { html, pluginContent, preCleanedContent } = bundle;
  const contentOriginal = baseUrl ? absolutizeUrls(html, baseUrl) : html;

  if (preCleanedContent || pluginContent?.skipReadability) {
    return { contentOriginal, contentCleaned: contentOriginal, readability: null };
  }

  const cleanOptions = { url: baseUrl ?? undefined, minCleanedLength: options.minCleanedLength };
  const readability = options.offload
    ? await cleanContentAsync(html, cleanOptions)
    : cleanContent(html, cleanOptions);

  return {
    contentOriginal,
    contentCleaned: readability?.content ?? (pluginContent ? contentOriginal : null),
    readability,
  };
}
