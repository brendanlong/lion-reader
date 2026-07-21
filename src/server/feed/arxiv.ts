/**
 * ArXiv URL handler for saved articles.
 *
 * ArXiv provides papers in multiple formats:
 * - /abs/XXXX.XXXXX - Abstract page
 * - /pdf/XXXX.XXXXX - PDF version
 * - /html/XXXX.XXXXX - HTML version (not available for all papers)
 *
 * This module transforms abstract and PDF URLs to their HTML equivalents
 * when the HTML version is available, providing a better reading experience.
 */

import { Parser } from "htmlparser2";
import { logger } from "@/lib/logger";
import { FEED_FETCH_TIMEOUT_MS, readResponseWithSizeLimit } from "@/server/http/fetch";
import { fetchWithSsrfProtection } from "@/server/http/ssrf";
import { USER_AGENT } from "@/server/http/user-agent";

// ============================================================================
// URL Parsing
// ============================================================================

/**
 * Pattern for matching ArXiv paper URLs.
 * Matches:
 *   https://arxiv.org/abs/2601.04649
 *   https://arxiv.org/pdf/2601.04649
 *   https://arxiv.org/html/2601.04649
 *   https://www.arxiv.org/abs/2601.04649v1 (with version)
 *
 * Paper IDs can be in old format (hep-th/9901001) or new format (2601.04649).
 */
const ARXIV_URL_PATTERN =
  /^https?:\/\/(?:www\.)?arxiv\.org\/(abs|pdf|html)\/([a-zA-Z0-9.\-/]+?(?:v\d+)?)(?:\.pdf)?(?:[?#].*)?$/;

/**
 * Checks if a URL is an ArXiv paper URL (abs, pdf, or html).
 */
export function isArxivUrl(url: string): boolean {
  return ARXIV_URL_PATTERN.test(url);
}

/**
 * Checks if a URL is an ArXiv abstract or PDF URL that could be transformed to HTML.
 * Excludes URLs that are already HTML.
 */
export function isArxivTransformableUrl(url: string): boolean {
  const match = url.match(ARXIV_URL_PATTERN);
  if (!match) return false;
  const type = match[1];
  return type === "abs" || type === "pdf";
}

/**
 * Extracts the paper ID from an ArXiv URL.
 * Returns null if the URL is not a valid ArXiv paper URL.
 *
 * @example
 * extractPaperId("https://arxiv.org/abs/2601.04649") // "2601.04649"
 * extractPaperId("https://arxiv.org/pdf/2601.04649v2") // "2601.04649"
 * extractPaperId("https://arxiv.org/abs/hep-th/9901001") // "hep-th/9901001"
 */
export function extractPaperId(url: string): string | null {
  const match = url.match(ARXIV_URL_PATTERN);
  return match ? match[2] : null;
}

/**
 * Builds the HTML version URL for an ArXiv paper.
 *
 * @param paperId - The paper ID (e.g., "2601.04649" or "hep-th/9901001")
 * @returns The HTML URL
 */
export function buildArxivHtmlUrl(paperId: string): string {
  return `https://arxiv.org/html/${paperId}`;
}

/**
 * Builds the abstract page URL for an ArXiv paper.
 *
 * @param paperId - The paper ID
 * @returns The abstract URL
 */
export function buildArxivAbsUrl(paperId: string): string {
  return `https://arxiv.org/abs/${paperId}`;
}

// ============================================================================
// HTML Version Detection
// ============================================================================

/**
 * Result of checking for ArXiv HTML version.
 */
interface ArxivHtmlCheckResult {
  /** Whether the HTML version exists */
  exists: boolean;
  /** The HTML URL (set regardless of whether it exists) */
  htmlUrl: string;
  /** The fallback URL to use if HTML doesn't exist (original URL) */
  fallbackUrl: string;
}

/**
 * Checks if the HTML version of an ArXiv paper exists.
 *
 * Not all ArXiv papers have HTML versions - it depends on the source format
 * (TeX papers are more likely to have HTML versions).
 *
 * @param url - The ArXiv URL (abs or pdf)
 * @returns Result indicating if HTML version exists
 */
async function checkArxivHtmlExists(url: string): Promise<ArxivHtmlCheckResult | null> {
  const paperId = extractPaperId(url);
  if (!paperId) {
    logger.debug("Not a valid ArXiv URL", { url });
    return null;
  }

  const htmlUrl = buildArxivHtmlUrl(paperId);
  const fallbackUrl = buildArxivAbsUrl(paperId);

  try {
    // Use HEAD request to check if HTML version exists without downloading it
    const response = await fetchWithSsrfProtection(htmlUrl, {
      method: "HEAD",
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
      redirect: "follow",
    });

    const exists = response.ok;
    logger.debug("ArXiv HTML version check", {
      paperId,
      htmlUrl,
      exists,
      status: response.status,
    });

    return { exists, htmlUrl, fallbackUrl };
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      logger.warn("ArXiv HTML check timed out", { paperId, htmlUrl });
    } else {
      logger.warn("ArXiv HTML check failed", {
        paperId,
        htmlUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // On error, assume HTML doesn't exist and fall back
    return { exists: false, htmlUrl, fallbackUrl };
  }
}

/**
 * Gets the best URL to fetch for an ArXiv paper.
 *
 * If the paper has an HTML version, returns that URL.
 * Otherwise, returns the original URL for normal fetching.
 *
 * @param url - The ArXiv URL (abs or pdf)
 * @returns The best URL to fetch, or null if not an ArXiv URL
 */
export async function getArxivFetchUrl(url: string): Promise<string | null> {
  if (!isArxivTransformableUrl(url)) {
    return null;
  }

  const result = await checkArxivHtmlExists(url);
  if (!result) {
    return null;
  }

  return result.exists ? result.htmlUrl : result.fallbackUrl;
}

// ============================================================================
// arXiv API metadata (title / abstract / authors)
// ============================================================================

/**
 * A single-entry Atom document from the arXiv API is a few KB; cap the read so a
 * misbehaving/hijacked response can't be buffered without bound.
 */
const ARXIV_API_MAX_BYTES = 1024 * 1024;

/** Structured metadata scraped from the arXiv Atom API for one paper. */
export interface ArxivApiMetadata {
  /** The paper title (feed-level query title is ignored). */
  title: string | null;
  /** The abstract, from Atom `<summary>` — a far better excerpt than a scrape. */
  summary: string | null;
  /** Author display names, in order, from `<author><name>`. */
  authors: string[];
}

/** Collapse runs of whitespace (arXiv wraps abstracts across lines) and trim. */
function normalizeArxivText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Parse an arXiv Atom API response (from `export.arxiv.org/api/query`) into the
 * paper's title, abstract, and author names.
 *
 * SAX-parsed (xmlMode) for the same reasons the rest of the codebase prefers it.
 * Only the **first** `<entry>` is read, and feed-level `<title>`/`<author>`
 * elements (the query echo) are ignored — we only capture inside `<entry>`.
 *
 * Pure (no network) so it can be unit-tested directly against fixture XML.
 */
export function parseArxivApiResponse(xml: string): ArxivApiMetadata {
  let title: string | null = null;
  let summary: string | null = null;
  const authors: string[] = [];

  let inEntry = false;
  let entryDone = false; // Stop capturing once the first <entry> closes.
  let inAuthor = false;
  let capture: "title" | "summary" | "name" | null = null;
  let buffer = "";

  const parser = new Parser(
    {
      onopentag(name) {
        const tag = name.toLowerCase();
        if (tag === "entry") {
          if (!entryDone) inEntry = true;
          return;
        }
        if (!inEntry) return;
        if (tag === "author") {
          inAuthor = true;
        } else if (tag === "title") {
          capture = "title";
          buffer = "";
        } else if (tag === "summary") {
          capture = "summary";
          buffer = "";
        } else if (tag === "name" && inAuthor) {
          capture = "name";
          buffer = "";
        }
      },
      ontext(text) {
        if (capture) buffer += text;
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (!inEntry) return;
        if (tag === "entry") {
          inEntry = false;
          entryDone = true;
        } else if (tag === "author") {
          inAuthor = false;
        } else if (tag === "title" && capture === "title") {
          title = normalizeArxivText(buffer) || null;
          capture = null;
        } else if (tag === "summary" && capture === "summary") {
          summary = normalizeArxivText(buffer) || null;
          capture = null;
        } else if (tag === "name" && capture === "name") {
          const authorName = normalizeArxivText(buffer);
          if (authorName) authors.push(authorName);
          capture = null;
        }
      },
    },
    { decodeEntities: true, xmlMode: true }
  );

  parser.write(xml);
  parser.end();

  return { title, summary, authors };
}

/**
 * Format an arXiv author list into the single `author` string a saved article
 * stores. Papers can carry dozens of authors, so a long list collapses to
 * "First Author et al." rather than an unwieldy full byline.
 */
export function formatArxivAuthors(authors: string[]): string | null {
  if (authors.length === 0) return null;
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} and ${authors[1]}`;
  return `${authors[0]} et al.`;
}

/**
 * Fetch a paper's structured metadata (title / abstract / authors) from the
 * arXiv Atom API. Returns null on any failure so the caller falls back to the
 * scraped HTML / Readability metadata.
 *
 * All outbound traffic goes through `fetchWithSsrfProtection` with our custom
 * User-Agent. This is one request per save (not bulk harvesting), so it stays
 * well within arXiv's API rate limits.
 */
export async function fetchArxivMetadata(paperId: string): Promise<ArxivApiMetadata | null> {
  const apiUrl = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(paperId)}`;
  try {
    const response = await fetchWithSsrfProtection(apiUrl, {
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
      redirect: "follow",
    });

    if (!response.ok) {
      logger.warn("ArXiv API request failed", { paperId, status: response.status });
      return null;
    }

    const xml = await readResponseWithSizeLimit(response, ARXIV_API_MAX_BYTES, apiUrl);
    const metadata = parseArxivApiResponse(xml);

    // A malformed / not-found response yields an empty entry — treat as a miss.
    if (!metadata.title && !metadata.summary && metadata.authors.length === 0) {
      logger.debug("ArXiv API returned no usable metadata", { paperId });
      return null;
    }

    logger.debug("Fetched ArXiv API metadata", {
      paperId,
      hasSummary: metadata.summary !== null,
      authorCount: metadata.authors.length,
    });
    return metadata;
  } catch (error) {
    logger.warn("ArXiv API request errored", {
      paperId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
