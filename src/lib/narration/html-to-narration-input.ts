/**
 * HTML to Narration Input Converter
 *
 * This module converts HTML content to structured text with paragraph markers
 * for LLM processing. Uses DOM parsing to ensure paragraph indices match
 * the client-side highlighting implementation.
 *
 * @module narration/html-to-narration-input
 */

import { JSDOM } from "jsdom";

/**
 * Block-level elements that get paragraph markers.
 * Must match the client-side BLOCK_ELEMENTS in client-paragraph-ids.ts
 */
const BLOCK_ELEMENTS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "li",
  "figure",
  "table",
  "img",
]);

/**
 * Result of converting HTML to narration input.
 */
export interface HtmlToNarrationInputResult {
  /** Text content with [P:X] markers for LLM processing */
  inputText: string;
  /** Array of paragraph identifiers in order they appear */
  paragraphOrder: string[];
}

/**
 * Converts an element's text content for narration.
 * Handles special elements like images, code blocks, etc.
 */
function getElementNarrationText(el: Element): string {
  const tagName = el.tagName.toLowerCase();

  // Handle headings
  if (tagName === "h1" || tagName === "h2") {
    return `[HEADING] ${el.textContent?.trim() || ""}`;
  }
  if (tagName === "h3" || tagName === "h4" || tagName === "h5" || tagName === "h6") {
    return `[SUBHEADING] ${el.textContent?.trim() || ""}`;
  }

  // Handle code blocks
  if (tagName === "pre") {
    const codeContent = el.textContent?.trim() || "";
    return `[CODE BLOCK]\n${codeContent}\n[END CODE BLOCK]`;
  }

  // Handle blockquotes
  if (tagName === "blockquote") {
    return `[QUOTE]\n${el.textContent?.trim() || ""}\n[END QUOTE]`;
  }

  // Handle lists (ul/ol get markers but their text comes from li children)
  if (tagName === "ul" || tagName === "ol") {
    return "[LIST]";
  }

  // Handle list items
  if (tagName === "li") {
    return `- ${el.textContent?.trim() || ""}`;
  }

  // Handle figures
  if (tagName === "figure") {
    const img = el.querySelector("img");
    const figcaption = el.querySelector("figcaption");
    const alt = img?.getAttribute("alt") || figcaption?.textContent?.trim() || "no description";
    return `[IMAGE: ${alt}]`;
  }

  // Handle tables
  if (tagName === "table") {
    // Extract table content in a readable format
    const rows: string[] = [];
    el.querySelectorAll("tr").forEach((tr) => {
      const cells: string[] = [];
      tr.querySelectorAll("th, td").forEach((cell) => {
        cells.push(cell.textContent?.trim() || "");
      });
      if (cells.length > 0) {
        rows.push(`[ROW] ${cells.join(" | ")}`);
      }
    });
    return `[TABLE]\n${rows.join("\n")}\n[END TABLE]`;
  }

  // Handle standalone images
  if (tagName === "img") {
    const alt = el.getAttribute("alt") || "image";
    return `[IMAGE: ${alt}]`;
  }

  // Handle regular paragraphs - process links and inline elements
  return processInlineContent(el);
}

/**
 * Process inline content, handling links and other inline elements.
 */
function processInlineContent(el: Element): string {
  let text = "";

  // Walk through child nodes
  el.childNodes.forEach((node) => {
    if (node.nodeType === 3) {
      // Text node
      text += node.textContent || "";
    } else if (node.nodeType === 1) {
      // Element node
      const childEl = node as Element;
      const childTag = childEl.tagName.toLowerCase();

      if (childTag === "a") {
        // Handle links
        const href = childEl.getAttribute("href");
        const linkText = childEl.textContent?.trim() || "";

        if (!linkText || linkText === href) {
          try {
            const domain = new URL(href || "").hostname;
            text += `[link to ${domain}]`;
          } catch {
            text += `[link to ${href}]`;
          }
        } else {
          text += linkText;
        }
      } else if (childTag === "code") {
        // Inline code
        text += `\`${childEl.textContent || ""}\``;
      } else if (childTag === "img") {
        // Inline image
        const alt = childEl.getAttribute("alt") || "image";
        text += `[IMAGE: ${alt}]`;
      } else {
        // Recurse for other inline elements (strong, em, span, etc.)
        text += processInlineContent(childEl);
      }
    }
  });

  return text.trim();
}

/**
 * Converts HTML to structured text for LLM processing with paragraph markers.
 * Uses DOM parsing to ensure paragraph indices are assigned in document order,
 * matching the client-side paragraph ID assignment.
 *
 * Adds [P:X] markers to indicate original paragraph indices, which the LLM
 * will transform to [PARA:X] markers in its output for highlighting support.
 *
 * @param html - HTML content to convert
 * @returns Object with inputText (marked text) and paragraphOrder (paragraph IDs)
 *
 * @example
 * const result = htmlToNarrationInput('<h2>Title</h2><p>Content</p>');
 * // Returns {
 * //   inputText: "[P:0] [HEADING] Title\n\n[P:1] Content",
 * //   paragraphOrder: ["para-0", "para-1"]
 * // }
 */
export function htmlToNarrationInput(html: string): HtmlToNarrationInputResult {
  // Handle empty input
  if (!html || html.trim() === "") {
    return {
      inputText: "",
      paragraphOrder: [],
    };
  }

  // Parse HTML using JSDOM
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const { Node } = dom.window;

  // Build selector for all block elements
  const blockElementsExceptImg = Array.from(BLOCK_ELEMENTS).filter((el) => el !== "img");
  const selector = blockElementsExceptImg.join(", ");

  // Find all block elements in document order
  const allElements = doc.querySelectorAll(selector);

  // Find standalone images (not nested inside other block elements)
  // An image is standalone if none of its ancestors are block elements
  const standaloneImages: Element[] = [];
  doc.querySelectorAll("img").forEach((img) => {
    let parent = img.parentElement;
    let isStandalone = true;

    while (parent && parent !== doc.body) {
      const parentTag = parent.tagName.toLowerCase();
      if (BLOCK_ELEMENTS.has(parentTag)) {
        isStandalone = false;
        break;
      }
      parent = parent.parentElement;
    }

    if (isStandalone) {
      standaloneImages.push(img);
    }
  });

  // Combine block elements and standalone images, then sort by document order
  const allElementsArray = Array.from(allElements);
  const combinedElements = [...allElementsArray, ...standaloneImages].sort((a, b) => {
    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  const paragraphOrder: string[] = [];
  const lines: string[] = [];

  combinedElements.forEach((el, index) => {
    const id = `para-${index}`;
    paragraphOrder.push(id);

    const marker = `[P:${index}]`;
    const text = getElementNarrationText(el);

    if (text) {
      lines.push(`${marker} ${text}`);
    }
  });

  // Join with double newlines for paragraph separation
  let inputText = lines.join("\n\n");

  // Normalize whitespace
  inputText = inputText
    .replace(/\u00A0/g, " ") // Convert nbsp to regular space
    .replace(/ +/g, " ") // Collapse multiple spaces
    .replace(/\n{3,}/g, "\n\n"); // Collapse multiple newlines

  return {
    inputText: inputText.trim(),
    paragraphOrder,
  };
}

/**
 * Converts HTML to plain text for fallback mode.
 * Basic conversion that strips tags but preserves structure.
 *
 * @param html - HTML content to convert
 * @returns Plain text with paragraph breaks
 *
 * @example
 * const text = htmlToPlainText('<p>Hello</p><p>World</p>');
 * // Returns "Hello\n\nWorld"
 */
export function htmlToPlainText(html: string): string {
  return (
    html
      // Extract alt text from standalone images (not in figures/paragraphs) and replace with text
      .replace(/<img\s+[^>]*alt=["']([^"']*)["'][^>]*>/gi, "\n\n[Image: $1]\n\n")
      .replace(/<img\s+[^>]*>/gi, "\n\n[Image]\n\n") // Images without alt
      // Add paragraph breaks before block elements
      .replace(/<(p|div|br|h[1-6]|li|tr|blockquote|pre|figure|table)[^>]*>/gi, "\n\n")
      // Remove all HTML tags
      .replace(/<[^>]+>/g, "")
      // Decode common HTML entities
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      // Normalize whitespace: collapse multiple spaces to single space
      .replace(/ +/g, " ")
      // Normalize paragraph breaks: collapse multiple newlines to double newline
      .replace(/\n{3,}/g, "\n\n")
      // Trim whitespace from each line
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      // Final trim
      .trim()
  );
}
