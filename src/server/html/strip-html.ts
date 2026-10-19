/**
 * HTML text extraction utilities using SAX parsing.
 */

import { createSaxParser } from "./sax";

/**
 * Block-level elements that should have whitespace after them.
 */
export const BLOCK_TAGS: ReadonlySet<string> = new Set([
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
export const SKIP_TAGS: ReadonlySet<string> = new Set([
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

  const parser = createSaxParser(
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

        // Exit early once there's more than fits, so the cut gets its "..."
        if (maxLength && result.length > maxLength) {
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

  return truncateAtWord(result.trim(), maxLength);
}

/** Truncates at a word boundary, dropping a partial word, with "..." inside `maxLength`. */
export function truncateAtWord(text: string, maxLength?: number): string {
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
