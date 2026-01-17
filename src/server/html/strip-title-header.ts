/**
 * Utility for stripping duplicate title headers from HTML content.
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

/**
 * Strips the first header element if its text content matches the given title.
 *
 * When content includes a title that matches the first header (h1-h6) in the body,
 * displaying both creates redundancy. This function removes the first header if
 * it matches the title, preventing duplication.
 *
 * Uses htmlparser2 for efficient SAX-style parsing with position tracking,
 * avoiding a full DOM parse.
 *
 * @param html - The HTML content
 * @param title - The title to compare against
 * @returns HTML with the title header removed if it matched
 */
export function stripTitleHeader(html: string, title: string): string {
  // State for tracking the first header element
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
          // Check if it's a header element (h1-h6)
          if (HEADER_TAGS.has(tag)) {
            isInHeader = true;
            headerDepth = 1;
          } else {
            // First element is not a header, stop parsing
            parser.pause();
          }
        } else if (isInHeader) {
          // Track nested elements inside the header
          headerDepth++;
        }
      },
      ontext(text) {
        // Check for non-whitespace text before any element
        if (!foundFirstElement && text.trim()) {
          // Non-whitespace text before first element, stop
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
            // Finished parsing the header, record end position
            // endIndex points to the character after '>'
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

  // If we found a header and got its end position, check if it matches the title
  if (headerEndIndex > 0 && normalizeText(headerText) === normalizeText(title)) {
    // Remove the header and any immediately following newlines
    return html.slice(headerEndIndex).replace(/^\n+/, "");
  }

  return html;
}
