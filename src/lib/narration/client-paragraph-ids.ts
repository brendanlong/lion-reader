/**
 * Client-Side Paragraph ID Processing for Narration Highlighting
 *
 * This module provides utilities to add paragraph IDs to HTML content
 * for highlighting during narration playback. It runs in the browser
 * using DOMParser (unlike the server-side version which uses JSDOM).
 *
 * @module narration/client-paragraph-ids
 */

import { BLOCK_ELEMENTS } from "./block-elements";
import {
  buildAlignedNarration,
  type NarrationElement,
  type ParagraphMapEntry,
} from "./paragraph-map";

// Re-export for backwards compatibility
export { BLOCK_ELEMENTS };
export type { ParagraphMapEntry };

/** Set version of `BLOCK_ELEMENTS` for efficient lookup. */
const BLOCK_ELEMENT_SET = new Set<string>(BLOCK_ELEMENTS);

/**
 * Result of adding paragraph IDs to HTML content.
 */
export interface AddParagraphIdsResult {
  /** HTML with data-para-id attributes added to block elements */
  html: string;
  /** Number of paragraph elements marked */
  paragraphCount: number;
}

/**
 * Adds data-para-id attributes to block-level elements in HTML content.
 *
 * This function is the client-side equivalent of preprocessHtmlForNarration()
 * from html-preprocessing.ts. It uses DOMParser for browser compatibility
 * instead of JSDOM.
 *
 * The IDs are assigned in document order (para-0, para-1, etc.) matching
 * how the server-side preprocessing assigns them.
 *
 * @param html - The HTML content to process
 * @returns Object containing the processed HTML and paragraph count
 *
 * @example
 * const result = addParagraphIdsToHtml('<p>First</p><h2>Title</h2><p>Second</p>');
 * // result.html contains:
 * // '<p data-para-id="para-0">First</p>
 * //  <h2 data-para-id="para-1">Title</h2>
 * //  <p data-para-id="para-2">Second</p>'
 * // result.paragraphCount: 3
 */
export function addParagraphIdsToHtml(html: string): AddParagraphIdsResult {
  // Handle empty input
  if (!html || html.trim() === "") {
    return {
      html: "",
      paragraphCount: 0,
    };
  }

  // Parse HTML using DOMParser
  const parser = new DOMParser();
  // Wrap in a container to handle fragment parsing correctly
  const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const container = doc.body.firstElementChild;

  if (!container) {
    return {
      html: "",
      paragraphCount: 0,
    };
  }

  // Build selector for all block elements
  const blockElementsExceptImg = BLOCK_ELEMENTS.filter((el) => el !== "img");
  const selector = blockElementsExceptImg.join(", ");

  // Find all block elements in document order
  const allElements = container.querySelectorAll(selector);

  // Find standalone images (not nested inside other block elements)
  // An image is standalone if none of its ancestors are block elements
  const standaloneImages: Element[] = [];
  container.querySelectorAll("img").forEach((img) => {
    let parent = img.parentElement;
    let isStandalone = true;

    while (parent && parent !== container) {
      const parentTag = parent.tagName.toLowerCase();
      if (BLOCK_ELEMENT_SET.has(parentTag)) {
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

  let paraIndex = 0;
  combinedElements.forEach((el) => {
    const id = `para-${paraIndex}`;
    el.setAttribute("data-para-id", id);
    paraIndex++;
  });

  return {
    html: container.innerHTML,
    paragraphCount: paraIndex,
  };
}

/**
 * Simple wrapper that returns just the processed HTML string.
 * Useful for direct integration with React's useMemo.
 *
 * @param html - The HTML content to process
 * @returns The processed HTML with data-para-id attributes
 *
 * @example
 * // In a React component
 * const processedContent = useMemo(() => {
 *   return processHtmlForHighlighting(content);
 * }, [content]);
 */
export function processHtmlForHighlighting(html: string): string {
  return addParagraphIdsToHtml(html).html;
}

/**
 * Creates a memoized version of addParagraphIdsToHtml using a simple cache.
 * This is useful when the same content may be processed multiple times.
 *
 * @param cacheSize - Maximum number of entries to cache (default: 10)
 * @returns A memoized version of addParagraphIdsToHtml
 *
 * @example
 * const memoizedAdd = createMemoizedAddParagraphIds(5);
 * const result1 = memoizedAdd('<p>Hello</p>'); // Processes
 * const result2 = memoizedAdd('<p>Hello</p>'); // Returns cached
 */
export function createMemoizedAddParagraphIds(
  cacheSize = 10
): (html: string) => AddParagraphIdsResult {
  const cache = new Map<string, AddParagraphIdsResult>();

  return (html: string): AddParagraphIdsResult => {
    // Check cache first
    const cached = cache.get(html);
    if (cached) {
      return cached;
    }

    // Process and cache the result
    const result = addParagraphIdsToHtml(html);

    // Enforce cache size limit (LRU-like: delete oldest entries)
    if (cache.size >= cacheSize) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) {
        cache.delete(firstKey);
      }
    }

    cache.set(html, result);
    return result;
  };
}

/**
 * Result of converting HTML to narration input on the client side.
 */
export interface ClientNarrationResult {
  /** Plain text narration content split by paragraph */
  narrationText: string;
  /** Paragraph mapping for highlighting (narration index -> original indices) */
  paragraphMap: ParagraphMapEntry[];
  /** HTML with data-para-id attributes added */
  processedHtml: string;
}

/**
 * How deep the walks below descend before flattening what is left. The markup
 * is feed-controlled and nests as deeply as it likes; the walks are recursive.
 */
const MAX_CONTENT_DEPTH = 64;

/** An image's spoken text, padded — nothing else guarantees a gap around it. */
function imageText(img: Element): string {
  const alt = img.getAttribute("alt");
  return alt && alt.trim() ? ` Image: ${alt.trim()} ` : "";
}

/**
 * Process inline content, handling images and other inline elements.
 * Recursively walks through child nodes to preserve image alt text.
 *
 * Block children are skipped: each one is its own paragraph in the list below,
 * so including their text here would narrate it twice — once for the wrapper
 * and once for the child (issue #1441). Images are the exception, since a
 * nested image never gets a paragraph of its own.
 */
function processInlineContent(el: Element): string {
  // Horizontal whitespace only: a blank line in the source is how a block with
  // `<br><br>` in it becomes two spoken paragraphs (see `./paragraph-map`).
  return inlineText(el)
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

/**
 * The inline text of an element's children, untrimmed — trimming at every level
 * of the walk swallows the space in `<b>Total:</b><span> 42</span>`.
 */
function inlineText(el: Element, depth = 0): string {
  if (depth >= MAX_CONTENT_DEPTH) {
    return el.textContent || "";
  }

  let text = "";
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const childEl = node as Element;
    const childTag = childEl.tagName.toLowerCase();
    if (childTag === "img") {
      text += imageText(childEl);
      return;
    }
    if (BLOCK_ELEMENT_SET.has(childTag)) return;
    // Recurse for other inline elements (strong, em, span, a, etc.)
    text += inlineText(childEl, depth + 1);
  });

  return text;
}

/**
 * The first matching descendant an element speaks for itself — one no block in
 * between has already claimed.
 */
function ownDescendant(el: Element, selector: string): Element | null {
  for (const candidate of Array.from(el.querySelectorAll(selector))) {
    let owner: Element | null = null;
    for (let parent = candidate.parentElement; parent; parent = parent.parentElement) {
      const tagName = parent.tagName.toLowerCase();
      if (tagName !== "img" && BLOCK_ELEMENT_SET.has(tagName)) {
        owner = parent;
        break;
      }
    }
    if (owner === el) return candidate;
  }
  return null;
}

/**
 * Everything inside an element, block children included, with the blocks kept
 * apart by a space.
 *
 * `processInlineContent` stops at block children because each narrates itself;
 * a table cell's blocks don't (the table speaks for them), so their text has to
 * come from here — and `textContent` won't do, since it drops image alt text.
 */
function subtreeNarrationText(el: Element): string {
  return subtreeText(el).replace(/\s+/g, " ").trim();
}

/**
 * The subtree's text, untrimmed — trimming at every level of the walk swallows
 * the space in `<b>Total:</b><span> 42</span>`.
 */
function subtreeText(el: Element, depth = 0): string {
  if (depth >= MAX_CONTENT_DEPTH) {
    return el.textContent || "";
  }

  let text = "";
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const childEl = node as Element;
    const childTag = childEl.tagName.toLowerCase();
    if (childTag === "img") {
      text += imageText(childEl);
      return;
    }
    if (childTag === "table") {
      // A table in a cell reads as a table, not as its cells glued together.
      text += ` ${tableNarrationText(childEl)} `;
      return;
    }
    if (childTag === "figure" && ownDescendant(childEl, "img")) {
      text += ` ${figureNarrationText(childEl)} `;
      return;
    }
    const inner = subtreeText(childEl, depth + 1);
    // Inline markup continues the run of text; a block starts a new one.
    text += BLOCK_ELEMENT_SET.has(childTag) ? ` ${inner} ` : inner;
  });

  return text;
}

/**
 * A figure's image, with the caption that nothing else narrates: the caption is
 * the description when there is no alt text, and extra detail when there is.
 *
 * A figure that holds no image of its own — one around a table or a list, or
 * one whose image a nested block already speaks — is not an image at all, so it
 * announces none and narrates whatever text it does hold.
 */
function figureNarrationText(el: Element): string {
  const img = ownDescendant(el, "img");
  if (!img) {
    return processInlineContent(el);
  }
  const alt = img.getAttribute("alt")?.trim();
  const caption = ownDescendant(el, "figcaption")?.textContent?.trim();
  if (!alt) {
    return caption ? `Image: ${caption}` : "";
  }
  return caption ? `Image: ${alt}. ${caption}` : `Image: ${alt}`;
}

/**
 * A table's rows, and the caption that no one else will narrate (issue #1445):
 * like the cells, the blocks inside it stay silent for the table's sake.
 */
function tableNarrationText(el: Element): string {
  const parts: string[] = [];
  const caption = el.querySelector("caption");
  if (caption?.closest("table") === el) {
    parts.push(subtreeNarrationText(caption));
  }
  el.querySelectorAll("tr").forEach((tr) => {
    // A nested table narrates its own rows — as a cell of this one.
    if (tr.closest("table") !== el) return;
    const cells: string[] = [];
    tr.querySelectorAll("th, td").forEach((cell) => {
      if (cell.closest("tr") !== tr) return;
      cells.push(subtreeNarrationText(cell));
    });
    if (cells.length > 0 && cells.some((c) => c.length > 0)) {
      parts.push(cells.join(", "));
    }
  });
  return parts.filter(Boolean).join(". ");
}

/**
 * Blocks whose narration already accounts for everything inside them: a table
 * speaks all of its cells, and a code block is deliberately not spoken at all.
 * A block nested in one of those has to stay silent, or its text comes back —
 * a second time for the table, and at all for the code block (issue #1445).
 *
 * A blockquote is not one of these: it speaks only its own text, so the
 * paragraphs inside it are the ones that narrate the quote.
 */
const SUBTREE_SPEAKERS = new Set(["pre", "table"]);

/**
 * Gets narration text for an element.
 * Handles special elements like images, code blocks, headings, etc.
 */
function getElementNarrationText(el: Element): string {
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if (SUBTREE_SPEAKERS.has(parent.tagName.toLowerCase())) return "";
  }

  const tagName = el.tagName.toLowerCase();

  // Handle headings - process inline content to capture any images
  if (tagName === "h1" || tagName === "h2") {
    return processInlineContent(el);
  }
  if (tagName === "h3" || tagName === "h4" || tagName === "h5" || tagName === "h6") {
    return processInlineContent(el);
  }

  // Handle code blocks
  if (tagName === "pre") {
    // Skip code blocks in narration - they're not meant to be read aloud
    return "";
  }

  // Handle blockquotes - process inline content to capture any images
  if (tagName === "blockquote") {
    return processInlineContent(el);
  }

  // Handle lists (ul/ol get markers but their text comes from li children)
  if (tagName === "ul" || tagName === "ol") {
    return "";
  }

  // Handle list items - process inline content to capture any images
  if (tagName === "li") {
    return processInlineContent(el);
  }

  // Handle figures. Only what the figure itself holds: an image inside a
  // nested block (a table, a list) is spoken by that block instead — and a
  // figure around one of those is not an image at all, so it announces none.
  if (tagName === "figure") {
    return figureNarrationText(el);
  }

  // Handle tables
  if (tagName === "table") {
    return tableNarrationText(el);
  }

  // Handle standalone images
  if (tagName === "img") {
    const alt = el.getAttribute("alt");
    if (alt && alt.trim()) {
      return `Image: ${alt.trim()}`;
    }
    // Images without alt text produce no narration
    return "";
  }

  // Handle regular paragraphs - process inline content to capture any images
  return processInlineContent(el);
}

/**
 * Converts HTML to narration-ready text with paragraph mapping.
 *
 * This is the client-side equivalent of the server's htmlToNarrationInput.
 * It uses the same block element iteration logic as addParagraphIdsToHtml
 * to ensure the narration paragraphs exactly match the DOM elements.
 *
 * @param html - HTML content to convert
 * @returns Object with narration text, paragraph map, and processed HTML
 *
 * @example
 * const result = htmlToClientNarration('<p>Hello</p><img src="x" alt="photo"><p>World</p>');
 * // result.narrationText: "Hello\n\nImage: photo\n\nWorld"
 * // result.paragraphMap: [{ n: 0, o: 0 }, { n: 1, o: 1 }, { n: 2, o: 2 }]
 * // result.processedHtml: '<p data-para-id="para-0">Hello</p>...'
 */
export function htmlToClientNarration(html: string): ClientNarrationResult {
  // Handle empty input
  if (!html || html.trim() === "") {
    return {
      narrationText: "",
      paragraphMap: [],
      processedHtml: "",
    };
  }

  // Parse HTML using DOMParser
  const parser = new DOMParser();
  // Wrap in a container to handle fragment parsing correctly
  const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const container = doc.body.firstElementChild;

  if (!container) {
    return {
      narrationText: "",
      paragraphMap: [],
      processedHtml: "",
    };
  }

  // Build selector for all block elements
  const blockElementsExceptImg = BLOCK_ELEMENTS.filter((el) => el !== "img");
  const selector = blockElementsExceptImg.join(", ");

  // Find all block elements in document order
  const allElements = container.querySelectorAll(selector);

  // Find standalone images (not nested inside other block elements)
  const standaloneImages: Element[] = [];
  container.querySelectorAll("img").forEach((img) => {
    let parent = img.parentElement;
    let isStandalone = true;

    while (parent && parent !== container) {
      const parentTag = parent.tagName.toLowerCase();
      if (BLOCK_ELEMENT_SET.has(parentTag)) {
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

  // Process each element: add data-para-id and collect its narration text.
  // Every combined element gets a data-para-id (matching its document-order
  // index) so the rendered DOM has a highlight target for each block; empty
  // elements simply contribute no narration paragraph.
  const elements: NarrationElement[] = [];
  combinedElements.forEach((el, elementIndex) => {
    el.setAttribute("data-para-id", `para-${elementIndex}`);
    elements.push({ o: elementIndex, text: getElementNarrationText(el) });
  });

  // Build the narration text and paragraph map together so the map has exactly
  // one entry per player paragraph even when a single block's text spans
  // multiple blank-line-separated paragraphs (see `./paragraph-map`).
  const { narrationText, paragraphMap } = buildAlignedNarration(elements);

  return {
    narrationText,
    paragraphMap,
    processedHtml: container.innerHTML,
  };
}
