/**
 * HTML Preprocessing for Narration Highlighting
 *
 * This module provides utilities to preprocess HTML content for narration,
 * assigning paragraph IDs to block-level elements for tracking and highlighting.
 *
 * @module narration/html-preprocessing
 */

import { JSDOM } from "jsdom";

/**
 * Block-level elements that can be highlighted during narration.
 * These elements are assigned data-para-id attributes for tracking.
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
  "img",
] as const;

/**
 * Result of preprocessing HTML for narration.
 */
export interface PreprocessResult {
  /** HTML with data-para-id attributes added to block elements */
  markedHtml: string;
  /** Array of paragraph IDs in document order */
  paragraphElements: string[];
}

/**
 * Preprocesses HTML content for narration by assigning stable IDs to block-level elements.
 *
 * This function parses the HTML, finds all block-level elements (p, h1-h6, blockquote,
 * pre, ul, ol, li, figure, table, img), and assigns each a unique `data-para-id` attribute
 * in document order.
 *
 * @param html - The HTML content to preprocess
 * @returns Object containing the marked HTML and array of paragraph IDs
 *
 * @example
 * const { markedHtml, paragraphElements } = preprocessHtmlForNarration(
 *   '<p>First paragraph</p><h2>Heading</h2><p>Second paragraph</p>'
 * );
 * // markedHtml contains:
 * // '<p data-para-id="para-0">First paragraph</p>
 * //  <h2 data-para-id="para-1">Heading</h2>
 * //  <p data-para-id="para-2">Second paragraph</p>'
 * // paragraphElements: ['para-0', 'para-1', 'para-2']
 */
export function preprocessHtmlForNarration(html: string): PreprocessResult {
  // Handle empty input
  if (!html || html.trim() === "") {
    return {
      markedHtml: "",
      paragraphElements: [],
    };
  }

  // Parse HTML using JSDOM
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Build selector for all block elements
  const selector = BLOCK_ELEMENTS.join(", ");

  // Find all block elements in document order and assign IDs
  const elements = doc.querySelectorAll(selector);
  const paragraphElements: string[] = [];

  let paraIndex = 0;
  elements.forEach((el) => {
    const id = `para-${paraIndex}`;
    el.setAttribute("data-para-id", id);
    paragraphElements.push(id);
    paraIndex++;
  });

  // Return the modified HTML
  // Note: JSDOM wraps content in <html><head></head><body>...</body></html>
  // We extract just the body content
  const markedHtml = doc.body.innerHTML;

  return {
    markedHtml,
    paragraphElements,
  };
}

/**
 * Checks if a tag name is a block-level element for narration purposes.
 *
 * @param tagName - The HTML tag name to check (case-insensitive)
 * @returns true if the tag is a block element, false otherwise
 *
 * @example
 * isBlockElement('p'); // true
 * isBlockElement('P'); // true
 * isBlockElement('span'); // false
 */
export function isBlockElement(tagName: string): boolean {
  return BLOCK_ELEMENTS.includes(tagName.toLowerCase() as (typeof BLOCK_ELEMENTS)[number]);
}
