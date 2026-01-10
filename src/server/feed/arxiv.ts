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

import { logger } from "@/lib/logger";
import { FEED_FETCH_TIMEOUT_MS } from "@/server/http/fetch";
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
  /^https?:\/\/(?:www\.)?arxiv\.org\/(abs|pdf|html)\/([a-zA-Z0-9.\-/]+?)(?:\.pdf)?(?:v\d+)?(?:[?#].*)?$/;

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
export interface ArxivHtmlCheckResult {
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
export async function checkArxivHtmlExists(url: string): Promise<ArxivHtmlCheckResult | null> {
  const paperId = extractPaperId(url);
  if (!paperId) {
    logger.debug("Not a valid ArXiv URL", { url });
    return null;
  }

  const htmlUrl = buildArxivHtmlUrl(paperId);
  const fallbackUrl = buildArxivAbsUrl(paperId);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);

  try {
    // Use HEAD request to check if HTML version exists without downloading it
    const response = await fetch(htmlUrl, {
      method: "HEAD",
      headers: {
        "User-Agent": USER_AGENT,
      },
      signal: controller.signal,
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
    if (error instanceof Error && error.name === "AbortError") {
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
  } finally {
    clearTimeout(timeout);
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
