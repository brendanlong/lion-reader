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
 */
const SKIP_TAGS = new Set(["script", "style"]);

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
        // br/hr are void elements - add space on open
        if ((tag === "br" || tag === "hr") && !lastWasSpace) {
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
