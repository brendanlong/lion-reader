import type { UrlPlugin, SavedArticleContent } from "./types";
import {
  buildArxivAbsUrl,
  buildArxivHtmlUrl,
  extractPaperId,
  formatArxivAuthors,
  parseArxivAbsMetadata,
} from "@/server/feed/arxiv";
import { fetchPluginPage } from "./fetch-page";
import { logger } from "@/lib/logger";

/**
 * ArXiv plugin for fetching papers in optimal format.
 *
 * Provides capability for:
 * - SavedArticle: Fetch ArXiv papers, preferring HTML version when available
 *
 * A paper is addressable two ways, and we want one thing from each: the HTML
 * render (`/html/`) reads far better than the abstract page but only exists for
 * papers submitted as TeX since late 2023, while the abstract page (`/abs/`)
 * always exists and carries the Highwire `citation_*` tags with the real title,
 * author list, and abstract. So fetch **both in parallel** and combine them —
 * content from the render when it exists, metadata always from the abstract
 * page.
 *
 * Both requests go to arxiv.org and take ~50ms each. Deliberately *not* used:
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
      async fetchContent(url: URL): Promise<SavedArticleContent | null> {
        // `matchUrl` is a looser path test than the id pattern, so the id can
        // fail to parse. An /html/ URL is still fetchable as given (it is
        // already the render); the other forms need the id to build a URL.
        const paperId = extractPaperId(url.href);
        const isHtmlUrl = /^\/html\//.test(url.pathname);

        const renderUrl = isHtmlUrl ? url.href : paperId ? buildArxivHtmlUrl(paperId) : null;
        const absUrl = paperId ? buildArxivAbsUrl(paperId) : null;

        return fetchArxivPaper(renderUrl, absUrl);
      },

      skipReadability: false, // Still want cleanup with Readability
      siteName: "arXiv",
    },
  },
};

/**
 * Fetch a paper's render and abstract page concurrently and combine them.
 *
 * Exported for the integration test, which drives the combination rules — which
 * page wins, and when a rate limit is fatal — against a loopback server.
 *
 * Rate limiting is held rather than thrown eagerly: `Promise.all` would abandon
 * a render we had already fetched just because the abstract page came back 429,
 * failing a save that could have succeeded with Readability-derived metadata.
 * The convention exists to stop us re-requesting a throttled host, and with a
 * body in hand there is nothing to re-request — so the rejection only surfaces
 * when neither page produced content.
 *
 * A render that blows the size cap likewise falls back to the abstract page
 * rather than failing the save. This is a deliberate exception to
 * `acquireArticleContent`'s "a size-limit violation is a hard failure" rule,
 * which exists to stop us silently degrading to a scrape of *the same*
 * oversized page; here the abstract page is a different, perfectly good
 * representation of the paper.
 */
export async function fetchArxivPaper(
  renderUrl: string | null,
  absUrl: string | null
): Promise<SavedArticleContent | null> {
  if (!renderUrl && !absUrl) {
    return null;
  }

  const [renderResult, absResult] = await Promise.allSettled([
    renderUrl
      ? fetchPluginPage(new URL(renderUrl), "arxiv", { notFoundIsExpected: true })
      : Promise.resolve(null),
    absUrl ? fetchPluginPage(new URL(absUrl), "arxiv") : Promise.resolve(null),
  ]);

  const render = renderResult.status === "fulfilled" ? renderResult.value : null;
  const abs = absResult.status === "fulfilled" ? absResult.value : null;

  // The render is the better read, but the abstract page is a fine article in
  // its own right when there is no render.
  const content = render ?? abs;
  if (!content) {
    // Nothing to save. If a fetch was rejected (only rate limiting rejects),
    // surface that so the save reports `upstreamRateLimited` instead of
    // falling through to a generic fetch of the same throttled host.
    const rejected = [renderResult, absResult].find((r) => r.status === "rejected");
    if (rejected) {
      throw rejected.reason;
    }
    return null;
  }

  logger.debug("Fetched ArXiv paper", {
    usedRender: render !== null,
    hasMetadata: abs !== null,
  });

  // Prefer the abstract page's structured fields; each falls back to null so
  // Readability/metadata still fill them when that fetch failed.
  const metadata = abs ? parseArxivAbsMetadata(abs.html) : null;

  return {
    html: content.html,
    title: metadata?.title ?? null,
    author: metadata ? formatArxivAuthors(metadata.authors) : null,
    excerpt: metadata?.summary ?? null,
    publishedAt: null,
    canonicalUrl: content.finalUrl,
  };
}
