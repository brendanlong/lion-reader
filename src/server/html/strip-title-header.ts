/**
 * Utility for extracting and stripping title headers from HTML content.
 *
 * When content is displayed with a separate title, having the same title
 * as the first header in the body creates redundancy. This utility detects
 * and removes such duplicate headers.
 */

import { Parser } from "htmlparser2";

/**
 * Normalizes text for comparison by removing extra whitespace and trimming.
 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Header tag names for matching */
const HEADER_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** Result of parsing the first header from HTML */
interface FirstHeaderInfo {
  /** The text content of the header (with whitespace normalized) */
  text: string;
  /** The end index in the HTML string (position after closing tag) */
  endIndex: number;
}

/**
 * Parses HTML to find the first header element (h1-h6).
 *
 * Uses htmlparser2 for efficient SAX-style parsing with position tracking.
 * Handles nested tags inside headers (e.g., <h1><strong>Title</strong></h1>).
 *
 * @param html - The HTML content to parse
 * @returns Header info if found, null otherwise
 */
function parseFirstHeader(html: string): FirstHeaderInfo | null {
  let foundFirstElement = false;
  let isInHeader = false;
  let headerDepth = 0;
  let headerText = "";
  let headerEndIndex = -1;

  const parser = new Parser(
    {
      onopentagname(name) {
        const tag = name.toLowerCase();

        if (!foundFirstElement) {
          foundFirstElement = true;
          if (HEADER_TAGS.has(tag)) {
            isInHeader = true;
            headerDepth = 1;
          } else {
            parser.pause();
          }
        } else if (isInHeader) {
          headerDepth++;
        }
      },
      ontext(text) {
        if (!foundFirstElement && text.trim()) {
          parser.pause();
          return;
        }

        if (isInHeader) {
          headerText += text;
        }
      },
      onclosetag() {
        if (isInHeader) {
          headerDepth--;
          if (headerDepth === 0) {
            headerEndIndex = parser.endIndex! + 1;
            isInHeader = false;
            parser.pause();
          }
        }
      },
    },
    { decodeEntities: true }
  );

  parser.write(html);
  parser.end();

  if (headerEndIndex > 0) {
    return {
      text: headerText.replace(/\s+/g, " ").trim(),
      endIndex: headerEndIndex,
    };
  }

  return null;
}

/**
 * Strips the first header element if its text content matches the given title.
 *
 * When content includes a title that matches the first header (h1-h6) in the body,
 * displaying both creates redundancy. This function removes the first header if
 * it matches the title, preventing duplication.
 *
 * @param html - The HTML content
 * @param title - The title to compare against
 * @returns HTML with the title header removed if it matched
 */
export function stripTitleHeader(html: string, title: string): string {
  const header = parseFirstHeader(html);

  if (header && normalizeText(header.text) === normalizeText(title)) {
    return html.slice(header.endIndex).replace(/^\n+/, "");
  }

  return html;
}

/**
 * Extracts the title from the first H1 header and strips it from the content.
 *
 * Use this when you want to use the first header as a title and remove it
 * from the body content to avoid duplication.
 *
 * @param html - The HTML content
 * @returns Object with extracted title (or null) and cleaned content
 */
export function extractAndStripTitleHeader(html: string): {
  title: string | null;
  content: string;
} {
  const header = parseFirstHeader(html);

  if (header) {
    return {
      title: header.text,
      content: html.slice(header.endIndex).replace(/^\n+/, ""),
    };
  }

  return { title: null, content: html };
}
