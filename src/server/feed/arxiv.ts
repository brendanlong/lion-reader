/**
 * ArXiv URL handler for saved articles.
 *
 * ArXiv provides papers in multiple formats:
 * - /abs/XXXX.XXXXX - Abstract page
 * - /pdf/XXXX.XXXXX - PDF version
 * - /html/XXXX.XXXXX - HTML version (not available for all papers)
 *
 * URL helpers here let the saved-article plugin address a paper in either form,
 * and `parseArxivAbsMetadata` reads the paper's title/abstract/authors off the
 * abstract page — the plugin fetches both forms in parallel and picks the HTML
 * render for content when it exists. Pure functions only; the plugin owns the
 * fetching.
 */

import { Parser } from "htmlparser2";

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
 * Extracts the paper ID from an ArXiv URL.
 * Returns null if the URL is not a valid ArXiv paper URL.
 *
 * The version suffix is **preserved**, and that is load-bearing: the id is fed
 * straight back into `buildArxivHtmlUrl`/`buildArxivAbsUrl`, and a paper's
 * abstract differs between versions, so dropping `v2` would save the wrong one.
 *
 * @example
 * extractPaperId("https://arxiv.org/abs/2601.04649") // "2601.04649"
 * extractPaperId("https://arxiv.org/pdf/2601.04649v2") // "2601.04649v2"
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
// Paper metadata (title / abstract / authors)
// ============================================================================

/** Structured metadata for one paper, scraped from its arXiv abstract page. */
export interface ArxivPaperMetadata {
  /** The paper title, from `citation_title`. */
  title: string | null;
  /** The abstract, from `citation_abstract` — a far better excerpt than a scrape. */
  summary: string | null;
  /** Author display names, in order, from the repeated `citation_author` tags. */
  authors: string[];
}

/** Collapse runs of whitespace (arXiv wraps abstracts across lines) and trim. */
function normalizeArxivText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Convert a Highwire `citation_author` value to normal reading order.
 *
 * The abstract page emits authors surname-first ("Tay, Yi"), which is wrong for
 * a byline. Split on the *first* comma only, so multi-part given names survive
 * ("Tran, Vinh Q." -> "Vinh Q. Tran"). Values with no comma are group or
 * collaboration names ("ATLAS Collaboration") and are left alone.
 */
function normalizeAuthorName(raw: string): string {
  const name = normalizeArxivText(raw);
  const comma = name.indexOf(",");
  if (comma === -1) return name;

  const surname = name.slice(0, comma).trim();
  const given = name.slice(comma + 1).trim();
  // One side empty ("Smith," / ", John") — no swap to make, but don't hand back
  // the stray comma either.
  if (!surname || !given) return surname || given;

  return `${given} ${surname}`;
}

/**
 * Parse an arXiv abstract page's Highwire `citation_*` meta tags into the
 * paper's title, abstract, and author names.
 *
 * The abstract page carries everything the `export.arxiv.org` Atom API returns,
 * so reading it here means the save never touches that host — which throttles
 * per source IP and, once throttled, stalls for 15-30s before returning 429.
 * Behind a shared egress IP that made every arXiv save wait out the full fetch
 * timeout and then discard the result.
 *
 * SAX-parsed (and stopped at `</head>`, where the tags live) for the same
 * reasons the rest of the codebase prefers it. Pure (no network) so it can be
 * unit-tested directly against fixture HTML.
 */
export function parseArxivAbsMetadata(html: string): ArxivPaperMetadata {
  let title: string | null = null;
  let summary: string | null = null;
  const authors: string[] = [];

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name.toLowerCase() !== "meta") return;

        const content = attribs.content;
        if (!content) return;

        switch (attribs.name?.toLowerCase()) {
          case "citation_title":
            title ??= normalizeArxivText(content) || null;
            break;
          case "citation_abstract":
            summary ??= normalizeArxivText(content) || null;
            break;
          case "citation_author": {
            const author = normalizeAuthorName(content);
            if (author) authors.push(author);
            break;
          }
        }
      },
      onclosetag(name) {
        // Every citation_* tag lives in <head>; don't parse the whole document.
        if (name.toLowerCase() === "head") parser.pause();
      },
    },
    { decodeEntities: true }
  );

  parser.write(html);
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
