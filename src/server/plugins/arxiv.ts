import type { UrlPlugin, SavedArticleContent } from "./types";
import {
  buildArxivAbsUrl,
  buildArxivHtmlUrl,
  extractPaperId,
  formatArxivAuthors,
  parseArxivAbsMetadata,
} from "@/server/feed/arxiv";
import { fetchHtmlPage, HttpFetchError } from "@/server/http/fetch";
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
        const paperId = extractPaperId(url.href);
        if (!paperId) {
          return null;
        }

        // An /html/ URL is fetched as given; /abs/ and /pdf/ are mapped to the
        // render, which may not exist (404 -> fall back to the abstract page).
        const isHtmlUrl = /^\/html\//.test(url.pathname);
        const renderUrl = isHtmlUrl ? url.href : buildArxivHtmlUrl(paperId);
        const absUrl = buildArxivAbsUrl(paperId);

        const [render, abs] = await Promise.all([
          fetchArxivPage(renderUrl, "html render"),
          fetchArxivPage(absUrl, "abstract page"),
        ]);

        // The render is the better read, but the abstract page is a fine
        // article in its own right when there is no render.
        const content = render ?? abs;
        if (!content) {
          return null;
        }

        logger.debug("Fetched ArXiv paper", {
          paperId,
          usedRender: render !== null,
          hasMetadata: abs !== null,
        });

        // Prefer the abstract page's structured fields; each falls back to null
        // so Readability/metadata still fill them when that fetch failed.
        const metadata = abs ? parseArxivAbsMetadata(abs.content) : null;

        return {
          html: content.content,
          title: metadata?.title ?? null,
          author: metadata ? formatArxivAuthors(metadata.authors) : null,
          excerpt: metadata?.summary ?? null,
          publishedAt: null,
          canonicalUrl: content.finalUrl,
        };
      },

      skipReadability: false, // Still want cleanup with Readability
      siteName: "arXiv",
    },
  },
};

/**
 * Fetch one of a paper's two pages, returning null if it isn't there.
 *
 * A 404 on the render is the ordinary case for older papers, so it isn't worth
 * a warning. Rate limiting is rethrown per the convention in `fetch-page.ts`:
 * swallowing it would drop us into `acquireArticleContent`'s generic fetch,
 * re-requesting the host that just throttled us.
 */
async function fetchArxivPage(
  url: string,
  what: string
): Promise<{ content: string; finalUrl: string } | null> {
  try {
    const result = await fetchHtmlPage(url);
    return { content: result.content, finalUrl: result.finalUrl };
  } catch (error) {
    if (error instanceof HttpFetchError) {
      if (error.isRateLimited()) {
        throw error;
      }
      if (error.status === 404) {
        logger.debug("ArXiv page not available", { url, what });
        return null;
      }
    }
    logger.warn("ArXiv page fetch failed", {
      url,
      what,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
