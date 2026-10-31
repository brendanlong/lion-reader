import type { UrlPlugin, SavedArticleContent, SavedArticlePdf } from "./types";
import {
  buildArxivAbsUrl,
  buildArxivHtmlUrl,
  buildArxivPdfUrl,
  extractPaperId,
  parseArxivAbsMetadata,
} from "@/server/feed/arxiv";
import { formatAuthors } from "@/server/feed/authors";
import { fetchArticle, HttpFetchError } from "@/server/http/fetch";
import { fetchPluginPage } from "./fetch-page";
import { logger } from "@/lib/logger";

/**
 * ArXiv plugin for fetching papers in optimal format.
 *
 * Provides capability for:
 * - SavedArticle: Fetch ArXiv papers, preferring HTML version when available
 *
 * A paper is addressable three ways. The HTML render (`/html/`) reads best but
 * only exists for papers submitted as TeX since late 2023; the PDF (`/pdf/`)
 * always has the full text; the abstract page (`/abs/`) always exists and
 * carries the Highwire `citation_*` tags with the real title, author list, and
 * abstract. So fetch the render and the abstract page **in parallel**, then
 * the PDF only when there is no render: content from the best of those,
 * metadata always from the abstract page.
 *
 * Each HTML request goes to arxiv.org and takes ~50ms. Deliberately *not* used:
 * `export.arxiv.org/api/query`, which returns the same metadata but throttles
 * per source IP and, once throttled, stalls 15-30s before answering 429 — from
 * a shared egress IP that cost every save the full fetch timeout and then threw
 * the result away.
 */
export const arxivPlugin: UrlPlugin = {
  name: "arxiv",
  hosts: ["arxiv.org", "www.arxiv.org"],

  matchUrl(url: URL): boolean {
    // Match /abs/, /pdf/, /html/ URLs
    return /^\/(abs|pdf|html)\//.test(url.pathname);
  },

  capabilities: {
    savedArticle: {
      async fetchContent(url: URL): Promise<SavedArticleContent | SavedArticlePdf | null> {
        // `matchUrl` is a looser path test than the id pattern, so the id can
        // fail to parse. An /html/ URL is still fetchable as given (it is
        // already the render); the other forms need the id to build a URL.
        const paperId = extractPaperId(url.href);
        const isHtmlUrl = /^\/html\//.test(url.pathname);

        return fetchArxivPaper({
          renderUrl: isHtmlUrl ? url.href : paperId ? buildArxivHtmlUrl(paperId) : null,
          absUrl: paperId ? buildArxivAbsUrl(paperId) : null,
          pdfUrl: paperId ? buildArxivPdfUrl(paperId) : null,
        });
      },

      skipReadability: false, // Still want cleanup with Readability
      siteName: "arXiv",
    },
  },
};

interface ArxivPaperUrls {
  renderUrl: string | null;
  absUrl: string | null;
  pdfUrl: string | null;
}

/**
 * Fetch a paper's render and abstract page concurrently, and its PDF when
 * there is no render, and combine them.
 *
 * Exported for the integration test, which drives the combination rules — which
 * representation wins, and when a rate limit is fatal — against a loopback
 * server.
 *
 * Rate limiting is held rather than thrown eagerly: `Promise.all` would abandon
 * a render we had already fetched just because the abstract page came back 429,
 * failing a save that could have succeeded with Readability-derived metadata.
 * The convention exists to stop us re-requesting a throttled host, and with a
 * body in hand there is nothing to re-request — so the rejection only surfaces
 * when nothing produced content. For the same reason a rate limit on either
 * page skips the PDF.
 *
 * A render or PDF that blows the size cap likewise falls back to the next
 * representation rather than failing the save. This is a deliberate exception
 * to `acquireArticleContent`'s "a size-limit violation is a hard failure" rule,
 * which exists to stop us silently degrading to a scrape of *the same*
 * oversized page; here the abstract page is a different, perfectly good
 * representation of the paper.
 */
export async function fetchArxivPaper({
  renderUrl,
  absUrl,
  pdfUrl,
}: ArxivPaperUrls): Promise<SavedArticleContent | SavedArticlePdf | null> {
  const [renderResult, absResult] = await Promise.allSettled([
    renderUrl
      ? fetchPluginPage(new URL(renderUrl), "arxiv", { notFoundIsExpected: true })
      : Promise.resolve(null),
    absUrl ? fetchPluginPage(new URL(absUrl), "arxiv") : Promise.resolve(null),
  ]);
  const render = renderResult.status === "fulfilled" ? renderResult.value : null;
  const abs = absResult.status === "fulfilled" ? absResult.value : null;
  // Only rate limiting rejects.
  const rateLimit = [renderResult, absResult].find((r) => r.status === "rejected");

  // Prefer the abstract page's structured fields; each falls back to null so
  // Readability/metadata (or the PDF's own) still fill them when that fetch failed.
  const parsed = abs ? parseArxivAbsMetadata(abs.html) : null;
  const metadata = {
    title: parsed?.title ?? null,
    author: parsed ? formatAuthors(parsed.authors) : null,
    excerpt: parsed?.summary ?? null,
  };

  let pdfRateLimit: unknown = null;
  const pdf =
    !render && !rateLimit && pdfUrl
      ? await fetchArxivPdf(pdfUrl).catch((error: unknown) => {
          pdfRateLimit = error;
          return null;
        })
      : null;

  logger.debug("Fetched ArXiv paper", {
    usedRender: render !== null,
    usedPdf: pdf !== null,
    hasMetadata: abs !== null,
  });

  if (pdf) return { ...metadata, ...pdf };

  // The render is the better read, but the abstract page is a fine article in
  // its own right when there is neither a render nor a PDF.
  const content = render ?? abs;
  if (!content) {
    // Nothing to save. If a fetch was rate limited, surface that so the save
    // reports `upstreamRateLimited` instead of falling through to a generic
    // fetch of the same throttled host.
    if (rateLimit) throw rateLimit.reason;
    if (pdfRateLimit) throw pdfRateLimit;
    return null;
  }

  return { html: content.html, ...metadata, publishedAt: null, canonicalUrl: content.finalUrl };
}

/**
 * The paper's PDF, or null when it couldn't be fetched (rethrowing only a rate
 * limit, for {@link fetchArxivPaper} to hold).
 */
async function fetchArxivPdf(url: string): Promise<{ pdf: Buffer; finalUrl: string } | null> {
  try {
    const fetched = await fetchArticle(url);
    if (fetched.format === "pdf") return { pdf: fetched.pdf, finalUrl: fetched.finalUrl };
    logger.warn("ArXiv PDF URL served a page, falling back to the abstract page", { url });
    return null;
  } catch (error) {
    if (error instanceof HttpFetchError && error.isRateLimited()) throw error;
    logger.warn("ArXiv PDF fetch failed, falling back to the abstract page", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
