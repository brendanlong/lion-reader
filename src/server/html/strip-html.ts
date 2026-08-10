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

  let result = "";
  let lastWasSpace = true; // Start true to avoid leading spaces
  let skipDepth = 0; // Track depth inside script/style tags

  const parser = new Parser(
    {
      onopentagname(name) {
        const tag = name.toLowerCase();
        if (SKIP_TAGS.has(tag)) {
          skipDepth++;
        }
        // Add space before block elements (includes br/hr which are void)
        if (BLOCK_TAGS.has(tag) && !lastWasSpace && result.length > 0) {
          result += " ";
          lastWasSpace = true;
        }
      },
      ontext(text) {
        if (skipDepth > 0) return;

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
        if (BLOCK_TAGS.has(tag) && !lastWasSpace) {
          result += " ";
          lastWasSpace = true;
        }
      },
    },
    { decodeEntities: true }
  );

  parser.write(html);
  parser.end();

  const trimmed = result.trim();

  // If no maxLength or within limit, return as-is
  if (!maxLength || trimmed.length <= maxLength) {
    return trimmed;
  }

  // Truncate at word boundary: find last space before maxLength, drop partial word
  const truncateAt = maxLength - 3; // Reserve space for "..."
  const lastSpace = trimmed.lastIndexOf(" ", truncateAt);

  if (lastSpace > 0) {
    return trimmed.slice(0, lastSpace) + "...";
  }

  // No space found - single long word, just hard truncate
  return trimmed.slice(0, truncateAt) + "...";
}

/**
 * Generates a summary from HTML content.
 *
 * Extracts text with proper spacing between block elements and truncates
 * to 300 characters at a word boundary.
 *
 * @param html - The HTML content to summarize
 * @returns Summary string (max 300 chars)
 */
export function generateSummary(html: string): string {
  return stripHtml(html, 300);
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
 * (saved articles, uploaded HTML/docx). It prefers the extracted
 * description/excerpt when it's substantial — that's usually a hand-written
 * `og:description` / meta description and reads better than a truncated first
 * paragraph — and only falls back to the article body text when the excerpt is
 * missing or too short to be a real description. Both are truncated to
 * `maxLength` at a word boundary.
 *
 * The ≥50-char guard keeps a junk/empty meta tag from winning; a page that sets
 * a site-wide (rather than per-article) description is a site problem, not a bug
 * to work around here — see the follow-up on smarter summary heuristics.
 *
 * Pure (no DB/network/native), so it can be unit-tested directly.
 */
export function summarizeCleanedContent(
  cleaned: { excerpt: string; textContent: string },
  maxLength = 300
): string {
  if (cleaned.excerpt && cleaned.excerpt.length >= 50) {
    return truncateText(cleaned.excerpt, maxLength);
  }
  return truncateText(cleaned.textContent, maxLength);
}
