/**
 * HTML text extraction utilities using SAX parsing.
 */

import { Parser } from "htmlparser2";

/**
 * Block-level elements that should have whitespace after them.
 */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "ul",
  "ol",
  "tr",
  "th",
  "td",
  "blockquote",
  "pre",
  "figure",
  "figcaption",
  "table",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
]);

/**
 * Tags whose content should be skipped entirely.
 *
 * An excerpt describes what the reader will actually see, so this mirrors the
 * read-path sanitizer's `DROP_WITH_CONTENT` (`native/sanitizer/core/src/
 * sanitize.rs`) — anything the sanitizer removes subtree-and-all can never
 * reach the rendered entry, so it must not reach the excerpt either. `iframe`
 * is here for the same reason: the sanitizer rebuilds allowed embeds from
 * scratch and drops the rest, so an iframe's fallback children are never
 * displayed.
 *
 * That set is mostly the HTML tokenizer's **raw text / RCDATA** elements, and
 * for those this is load-bearing rather than cosmetic: the tokenizer reads
 * their contents as a single *text* run, so `ontext` hands us the inner markup
 * verbatim and an excerpt would otherwise read `<p>Fallback <b>text</b></p>`
 * instead of dropping it. (htmlparser2 12 made `iframe`/`noembed`/`noframes`/
 * `plaintext` raw text to match the spec; `script`/`style` always were.)
 *
 * `annotation`/`annotation-xml` are not raw text but belong for the sibling
 * reason: they hold MathML's alternate encodings (e.g. a copy of the TeX source
 * alongside the presentation MathML), so including them would duplicate each
 * equation in the excerpt — once from the presentation glyphs and once from the
 * TeX annotation (#1386).
 *
 * `head` is ours alone (the sanitizer never sees a whole document).
 */
const SKIP_TAGS = new Set([
  "script",
  "style",
  "textarea",
  "option",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
  "annotation",
  "annotation-xml",
  "head",
]);

/**
 * Elements a summary skips: headings, tables and captions are labels and
 * scaffolding around the prose ("Summary", "Abstract", column headers), and
 * reading them inline fuses them into the sentence that follows. A document
 * with no other text keeps them (see {@link generateSummary}).
 */
const SUMMARY_SKIP_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "table", "figcaption"]);

/** In-page links whose text is only a footnote marker: `1`, `[12]`, `*`, `†`. */
const FOOTNOTE_MARKER = /^\[?(?:\d{1,3}|[*†‡§])\]?$/;

/** The footer Yoast/WordPress appends to every feed item. */
const WORDPRESS_FEED_FOOTER = /^The post .+ appeared first on .+\.$/;
const MAX_FOOTER_LENGTH = 500;

const SUPERSCRIPTS: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "−": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
};

const SUBSCRIPTS: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "−": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
};

/**
 * Longest super/subscript we try to transliterate. Real ones are an exponent or
 * an index; the cap also keeps closing deeply nested ones linear.
 */
const MAX_SCRIPT_LENGTH = 8;

/** Rewrites `text` in Unicode super/subscripts, or returns null if any character has none. */
function transliterate(text: string, table: Record<string, string>): string | null {
  let out = "";
  for (const char of text) {
    const mapped = table[char];
    if (mapped === undefined) return null;
    out += mapped;
  }
  return out;
}

/** Which script a MathML element's `childIndex`-th child (1-based) is set in. */
function mathScriptTable(parent: string, childIndex: number): Record<string, string> | undefined {
  if (parent === "msup") return childIndex === 2 ? SUPERSCRIPTS : undefined;
  if (parent === "msub") return childIndex === 2 ? SUBSCRIPTS : undefined;
  if (parent === "msubsup") {
    return childIndex === 2 ? SUBSCRIPTS : childIndex === 3 ? SUPERSCRIPTS : undefined;
  }
  return undefined;
}

/** An alt that describes the image, not a filename or URL standing in for one. */
function isDescriptiveAlt(alt: string): boolean {
  return /\s/.test(alt) && !/^(?:https?:)?\/\//i.test(alt);
}

interface ExtractOptions {
  maxLength?: number;
  /** Apply the summary rules: transliteration, footnote/boilerplate dropping, alt fallback. */
  summary?: boolean;
  /** Skip {@link SUMMARY_SKIP_TAGS} (summary mode only). */
  skipLabels?: boolean;
}

interface OpenElement {
  tag: string;
  /** `result.length` when the element opened. */
  start: number;
  childCount: number;
  /** Set on links whose text we may drop: in-page footnote refs and comment links. */
  dropIfMarker?: boolean;
  dropAlways?: boolean;
  rawText?: string;
}

interface Extracted {
  text: string;
  /**
   * Longest descriptive image alt, for documents with no text (summary mode
   * only). Longest, because the main image is described and navigation
   * buttons ("Next Page") are only labelled.
   */
  imageAlt: string | null;
}

function extractText(html: string, options: ExtractOptions): Extracted {
  const { maxLength, summary = false, skipLabels = false } = options;
  let result = "";
  let lastWasSpace = true; // Start true to avoid leading spaces
  let skipDepth = 0; // Track depth inside script/style tags
  let labelDepth = 0;
  let imageAlt: string | null = null;
  const stack: OpenElement[] = [];
  let openLink: OpenElement | null = null;

  const truncateTo = (length: number) => {
    result = result.slice(0, length);
    lastWasSpace = result.length === 0 || result.endsWith(" ");
  };

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tag = name.toLowerCase();
        if (SKIP_TAGS.has(tag)) {
          skipDepth++;
        }
        // Add space before block elements (includes br/hr which are void)
        if (BLOCK_TAGS.has(tag) && !lastWasSpace && result.length > 0) {
          result += " ";
          lastWasSpace = true;
        }
        if (!summary) return;

        if (skipLabels && SUMMARY_SKIP_TAGS.has(tag)) {
          labelDepth++;
        }
        const parent = stack.at(-1);
        if (parent) {
          parent.childCount++;
          if (parent.tag === "mfrac" && parent.childCount === 2) {
            result += "/";
            lastWasSpace = false;
          }
        }
        const element: OpenElement = { tag, start: result.length, childCount: 0 };
        if (tag === "a" && !openLink) {
          const href = attribs.href ?? "";
          if (href.endsWith("#comments")) {
            element.dropAlways = true;
          } else if (href.startsWith("#")) {
            element.dropIfMarker = true;
            element.rawText = "";
          }
          if (element.dropAlways || element.dropIfMarker) openLink = element;
        }
        if (tag === "img" && skipDepth === 0) {
          const alt = attribs.alt?.trim().replace(/\s+/g, " ") ?? "";
          if (isDescriptiveAlt(alt) && alt.length > (imageAlt?.length ?? 0)) imageAlt = alt;
        }
        stack.push(element);
      },
      ontext(text) {
        if (skipDepth > 0 || labelDepth > 0) return;
        if (openLink?.rawText !== undefined) openLink.rawText += text;

        // Normalize whitespace and append character by character with deduplication
        const normalized = text.replace(/\s+/g, " ");
        for (const char of normalized) {
          if (char === " ") {
            if (!lastWasSpace && result.length > 0) {
              result += " ";
              lastWasSpace = true;
            }
          } else {
            result += char;
            lastWasSpace = false;
          }
        }

        // Exit early if we have enough text
        if (maxLength && result.length >= maxLength) {
          parser.pause();
        }
      },
      onclosetag(name) {
        const tag = name.toLowerCase();
        if (SKIP_TAGS.has(tag)) {
          skipDepth--;
        }
        if (summary) {
          if (skipLabels && SUMMARY_SKIP_TAGS.has(tag)) {
            labelDepth--;
          }
          const element = stack.pop();
          if (element) closeSummaryElement(element);
        }
        if (BLOCK_TAGS.has(tag) && !lastWasSpace) {
          result += " ";
          lastWasSpace = true;
        }
      },
    },
    { decodeEntities: true }
  );

  function closeSummaryElement(element: OpenElement) {
    if (element === openLink) {
      openLink = null;
      if (element.dropAlways || FOOTNOTE_MARKER.test(element.rawText?.trim() ?? "")) {
        truncateTo(element.start);
        return;
      }
    }
    const length = result.length - element.start;
    if (length === 0) return;

    const parent = stack.at(-1);
    const table =
      element.tag === "sup"
        ? SUPERSCRIPTS
        : element.tag === "sub"
          ? SUBSCRIPTS
          : parent && mathScriptTable(parent.tag, parent.childCount);
    if (table) {
      if (length > MAX_SCRIPT_LENGTH) return;
      const converted = transliterate(result.slice(element.start), table);
      if (converted !== null) {
        result = result.slice(0, element.start) + converted;
      }
    } else if (
      element.tag === "p" &&
      length <= MAX_FOOTER_LENGTH &&
      WORDPRESS_FEED_FOOTER.test(result.slice(element.start).trim())
    ) {
      truncateTo(element.start);
    }
  }

  parser.write(html);
  parser.end();

  return { text: result.trim(), imageAlt };
}

/** Truncates at a word boundary, dropping a partial word, with "..." inside `maxLength`. */
function truncateAtWord(text: string, maxLength?: number): string {
  if (!maxLength || text.length <= maxLength) {
    return text;
  }

  const truncateAt = maxLength - 3; // Reserve space for "..."
  const lastSpace = text.lastIndexOf(" ", truncateAt);

  if (lastSpace > 0) {
    return text.slice(0, lastSpace) + "...";
  }

  // No space found - single long word, just hard truncate
  return text.slice(0, truncateAt) + "...";
}

/**
 * Extracts text from HTML with proper spacing between block elements.
 *
 * Uses htmlparser2 for streaming SAX-style parsing, which is fast and handles
 * malformed HTML well. Adds spaces after block-level elements to prevent
 * headings and paragraphs from running together. Skips script/style content.
 *
 * @param html - The HTML content to extract text from
 * @param maxLength - Optional maximum characters to extract. If provided, truncates
 *                    at word boundary with ellipsis. Parser exits early once enough
 *                    text is collected.
 * @returns Plain text with proper spacing
 */
export function stripHtml(html: string, maxLength?: number): string {
  if (!html) {
    return "";
  }
  return truncateAtWord(extractText(html, { maxLength }).text, maxLength);
}

/** Longest summary (entry preview text) we generate, in characters. */
export const SUMMARY_MAX_LENGTH = 300;

/**
 * Generates a plain-text summary (entry preview) from HTML content, truncated
 * to {@link SUMMARY_MAX_LENGTH} characters at a word boundary.
 *
 * On top of {@link stripHtml}, it aims for the prose a reader would quote:
 * headings, tables and captions are skipped unless nothing else is left,
 * footnote markers, comment links and WordPress's feed footer are dropped,
 * short super/subscripts become Unicode (`x²`, `H₂O`) when every character has
 * a Unicode form, and an image-only document (a comic) is summarized by its
 * longest descriptive alt text unless `imageAlt` is false.
 */
export function generateSummary(html: string, { imageAlt = true } = {}): string {
  if (!html) {
    return "";
  }
  const maxLength = SUMMARY_MAX_LENGTH;
  const prose = extractText(html, { maxLength, summary: true, skipLabels: true });
  if (prose.text) {
    return truncateAtWord(prose.text, maxLength);
  }
  const withLabels = extractText(html, { maxLength, summary: true });
  if (withLabels.text) {
    return truncateAtWord(withLabels.text, maxLength);
  }
  if (!imageAlt) {
    return "";
  }
  return prose.imageAlt ? truncateText(prose.imageAlt, maxLength) : "";
}

/**
 * Truncates plain text to a maximum length at a word boundary, adding an
 * ellipsis when it had to cut. (Operates on already-plain text, unlike
 * `stripHtml`, which parses HTML first — so it's safe for text that may contain
 * `<`/`>` from math/LaTeX, e.g. an arXiv abstract.)
 */
export function truncateText(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  // Try to find a word boundary before the max length
  let truncated = trimmed.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLength - 50) {
    truncated = truncated.slice(0, lastSpace);
  }

  return truncated.trimEnd() + "...";
}

/**
 * Builds a plain-text summary from already-cleaned (Readability) content.
 *
 * This is the single source of truth for turning cleaned content into an
 * excerpt, shared by every surface that runs Readability then needs a preview
 * (saved articles, uploaded HTML/docx). It prefers the page's description
 * when it's substantial — that's usually a hand-written `og:description` /
 * meta description and reads better than a truncated first paragraph — and
 * otherwise summarizes the cleaned article HTML with {@link generateSummary}.
 *
 * The ≥50-char guard keeps a junk/empty meta tag from winning. A page that sets
 * a site-wide (rather than per-article) description is a site problem, not
 * something to detect here.
 *
 * Pure (no DB/network/native), so it can be unit-tested directly.
 */
export function summarizeCleanedContent(cleaned: { excerpt: string; content: string }): string {
  if (cleaned.excerpt && cleaned.excerpt.length >= 50) {
    return truncateText(cleaned.excerpt, SUMMARY_MAX_LENGTH);
  }
  return generateSummary(cleaned.content);
}
