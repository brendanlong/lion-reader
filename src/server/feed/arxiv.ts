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

import { createSaxParser } from "@/server/html/sax";

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

const TEX_FORMATTING_COMMAND =
  /\\(?:emph|textit|textbf|texttt|textsc|textsf|underline)\{([^{}]*)\}/g;

/** Deepest nesting we unwrap; each level costs a pass over the text. */
const MAX_TEX_NESTING = 3;

/**
 * Unwraps TeX text-formatting commands (`\emph{deception}` → `deception`), which
 * authors leave in titles and abstracts. Math (`$O(n^2)$`, `$\textbf{x}$`) is
 * left alone: it reads fine as TeX, and there formatting carries meaning.
 */
function stripTexFormatting(text: string): string {
  return text
    .split(/(\$[^$]*\$)/)
    .map((part, i) => {
      if (i % 2 === 1) return part; // a math span
      for (let pass = 0; pass < MAX_TEX_NESTING; pass++) {
        part = part.replace(TEX_FORMATTING_COMMAND, "$1");
      }
      return part;
    })
    .join("");
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

  const parser = createSaxParser(
    {
      onopentag(name, attribs) {
        if (name.toLowerCase() !== "meta") return;

        const content = attribs.content;
        if (!content) return;

        switch (attribs.name?.toLowerCase()) {
          case "citation_title":
            title ??= stripTexFormatting(normalizeArxivText(content)) || null;
            break;
          case "citation_abstract":
            summary ??= stripTexFormatting(normalizeArxivText(content)) || null;
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
