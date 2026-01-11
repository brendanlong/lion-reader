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

// Re-export for backwards compatibility
export { BLOCK_ELEMENTS };

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
  const blockElementSet = new Set(BLOCK_ELEMENTS);
  const standaloneImages: Element[] = [];
  container.querySelectorAll("img").forEach((img) => {
    let parent = img.parentElement;
    let isStandalone = true;

    while (parent && parent !== container) {
      const parentTag = parent.tagName.toLowerCase();
      if (blockElementSet.has(parentTag as (typeof BLOCK_ELEMENTS)[number])) {
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
 * Paragraph mapping entry for highlighting support.
 * Maps a narration paragraph index to the original HTML element index.
 */
export interface ParagraphMapEntry {
  /** Narration paragraph index */
  n: number;
  /** Original HTML element index (corresponds to data-para-id) */
  o: number;
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
 * Process inline content, handling images and other inline elements.
 * Recursively walks through child nodes to preserve image alt text.
 */
function processInlineContent(el: Element): string {
  let text = "";

  // Walk through child nodes
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      // Text node
      text += node.textContent || "";
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Element node
      const childEl = node as Element;
      const childTag = childEl.tagName.toLowerCase();

      if (childTag === "img") {
        // Inline image - include alt text
        const alt = childEl.getAttribute("alt");
        if (alt && alt.trim()) {
          text += `Image: ${alt.trim()}`;
        }
      } else {
        // Recurse for other inline elements (strong, em, span, a, etc.)
        text += processInlineContent(childEl);
      }
    }
  });

  return text.trim();
}

/**
 * Gets narration text for an element.
 * Handles special elements like images, code blocks, headings, etc.
 */
function getElementNarrationText(el: Element): string {
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

  // Handle figures
  if (tagName === "figure") {
    const img = el.querySelector("img");
    const figcaption = el.querySelector("figcaption");
    const alt = img?.getAttribute("alt") || figcaption?.textContent?.trim();
    if (alt) {
      return `Image: ${alt}`;
    }
    return "";
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
      if (cells.length > 0 && cells.some((c) => c.length > 0)) {
        rows.push(cells.join(", "));
      }
    });
    return rows.join(". ");
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
 * // result.paragraphMap: [{ n: 0, o: [0] }, { n: 1, o: [1] }, { n: 2, o: [2] }]
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
  const blockElementSet = new Set(BLOCK_ELEMENTS);
  const standaloneImages: Element[] = [];
  container.querySelectorAll("img").forEach((img) => {
    let parent = img.parentElement;
    let isStandalone = true;

    while (parent && parent !== container) {
      const parentTag = parent.tagName.toLowerCase();
      if (blockElementSet.has(parentTag as (typeof BLOCK_ELEMENTS)[number])) {
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

  const narrationParagraphs: string[] = [];
  const paragraphMap: ParagraphMapEntry[] = [];

  // Process each element: add data-para-id and extract narration text
  combinedElements.forEach((el, elementIndex) => {
    const id = `para-${elementIndex}`;
    el.setAttribute("data-para-id", id);

    const text = getElementNarrationText(el);

    // Only add non-empty text to narration
    if (text) {
      const narrationIndex = narrationParagraphs.length;
      narrationParagraphs.push(text);
      paragraphMap.push({
        n: narrationIndex,
        o: elementIndex,
      });
    }
  });

  return {
    narrationText: narrationParagraphs.join("\n\n"),
    paragraphMap,
    processedHtml: container.innerHTML,
  };
}
