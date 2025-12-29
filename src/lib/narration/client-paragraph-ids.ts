/**
 * Client-Side Paragraph ID Processing for Narration Highlighting
 *
 * This module provides utilities to add paragraph IDs to HTML content
 * for highlighting during narration playback. It runs in the browser
 * using DOMParser (unlike the server-side version which uses JSDOM).
 *
 * @module narration/client-paragraph-ids
 */

/**
 * Block-level elements that can be highlighted during narration.
 * This matches the server-side BLOCK_ELEMENTS constant.
 */
export const BLOCK_ELEMENTS = [
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
] as const;

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
  const selector = BLOCK_ELEMENTS.join(", ");

  // Find all block elements in document order and assign IDs
  const elements = container.querySelectorAll(selector);
  let paraIndex = 0;

  elements.forEach((el) => {
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
