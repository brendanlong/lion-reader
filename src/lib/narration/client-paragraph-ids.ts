/**
 * Client-side narration: paragraph marking and TTS text.
 *
 * Runs in the browser (`DOMParser`, not linkedom) and does two things with the
 * already-sanitized entry HTML: mark the elements narration can highlight with
 * `data-para-id`, and — when there is no LLM in the loop — derive the text the
 * TTS engine speaks. Both come from the shared walk in `./runs`, so the
 * paragraph indices match the server's (see `./html-to-narration-input`).
 *
 * @module narration/client-paragraph-ids
 */

import { narrationTargets } from "./block-elements";
import { buildAlignedNarration, type ParagraphMapEntry } from "./paragraph-map";
import { DIRECT_TTS_VOICE, narrationRuns } from "./runs";

export type { ParagraphMapEntry };

/**
 * Result of adding paragraph IDs to HTML content.
 */
export interface AddParagraphIdsResult {
  /** HTML with data-para-id attributes added to the elements narration can highlight */
  html: string;
  /** Number of marked elements */
  paragraphCount: number;
}

/**
 * Parses entry HTML and marks every element narration can highlight with
 * `data-para-id="para-{index}"`, numbered in document order.
 *
 * The numbering is `narrationTargets`, which the server uses too — that is what
 * makes a narration paragraph's `o` name the same element here.
 */
function markParagraphs(html: string): { container: Element; count: number } | null {
  const parser = new DOMParser();
  // Wrap in a container to handle fragment parsing correctly
  const doc = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const container = doc.body.firstElementChild;
  if (!container) return null;

  const targets = narrationTargets(container);
  targets.forEach((el, index) => el.setAttribute("data-para-id", `para-${index}`));
  return { container, count: targets.length };
}

/**
 * Adds data-para-id attributes to the elements narration can highlight.
 *
 * Used for the server-narration path, where the text comes from the LLM and the
 * client only needs the highlight targets.
 *
 * @param html - The HTML content to process
 * @returns Object containing the processed HTML and marked-element count
 *
 * @example
 * const result = addParagraphIdsToHtml('<p>First</p><h2>Title</h2>');
 * // result.html contains:
 * // '<p data-para-id="para-0">First</p><h2 data-para-id="para-1">Title</h2>'
 * // result.paragraphCount: 2
 */
export function addParagraphIdsToHtml(html: string): AddParagraphIdsResult {
  if (!html || html.trim() === "") {
    return { html: "", paragraphCount: 0 };
  }

  const marked = markParagraphs(html);
  if (!marked) {
    return { html: "", paragraphCount: 0 };
  }
  return { html: marked.container.innerHTML, paragraphCount: marked.count };
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
 * Converts HTML to narration-ready text with paragraph mapping.
 *
 * The client-side counterpart of the server's `htmlToNarrationInput`: the same
 * walk over the same elements, in the plain voice a TTS engine speaks verbatim
 * rather than the annotated one the LLM is fed.
 *
 * @param html - HTML content to convert
 * @returns Object with narration text, paragraph map, and processed HTML
 *
 * @example
 * const result = htmlToClientNarration('<p>Hello</p><img src="x" alt="photo">');
 * // result.narrationText: "Hello\n\nImage: photo"
 * // result.paragraphMap: [{ n: 0, o: 0 }, { n: 1, o: 1 }]
 * // result.processedHtml: '<p data-para-id="para-0">Hello</p>...'
 */
export function htmlToClientNarration(html: string): ClientNarrationResult {
  if (!html || html.trim() === "") {
    return { narrationText: "", paragraphMap: [], processedHtml: "" };
  }

  const marked = markParagraphs(html);
  if (!marked) {
    return { narrationText: "", paragraphMap: [], processedHtml: "" };
  }

  // The runs are the player's paragraphs, in order, each naming the element it
  // highlights; `buildAlignedNarration` keeps the map aligned with how the
  // player splits the text it is given (see `./paragraph-map`).
  const { narrationText, paragraphMap } = buildAlignedNarration(
    narrationRuns(marked.container, DIRECT_TTS_VOICE)
  );

  return {
    narrationText,
    paragraphMap,
    processedHtml: marked.container.innerHTML,
  };
}
