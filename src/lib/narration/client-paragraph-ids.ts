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
import type { ParagraphMapEntry } from "./paragraph-map";
import { directNarration } from "./runs";

export type { ParagraphMapEntry };

/**
 * Parsed into a document with an explicit `<body>`, exactly as the server
 * parses it, rather than into a wrapper element: a `</div>` with no opening tag
 * (which the sanitizer passes through, being a streaming rewriter rather than a
 * tree builder) closes a wrapper early, and everything after it would be
 * dropped from the article.
 */
function parseBody(html: string): HTMLElement {
  return new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${html}</body></html>`,
    "text/html"
  ).body;
}

/**
 * Marks every element narration can highlight with
 * `data-para-id="para-{index}"`, numbered in document order, and returns the
 * HTML to render.
 *
 * The numbering is `narrationTargets`, which the server uses too — that is what
 * makes a narration paragraph's `o` name the same element here.
 *
 * @example
 * processHtmlForHighlighting('<p>First</p><h2>Title</h2>');
 * // '<p data-para-id="para-0">First</p><h2 data-para-id="para-1">Title</h2>'
 */
export function processHtmlForHighlighting(html: string): string {
  const body = parseBody(html);
  narrationTargets(body).forEach((el, index) => el.setAttribute("data-para-id", `para-${index}`));
  return body.innerHTML;
}

/**
 * Result of converting HTML to narration input on the client side.
 */
export interface ClientNarrationResult {
  /** Plain text narration content split by paragraph */
  narrationText: string;
  /** Paragraph mapping for highlighting (narration index -> original indices) */
  paragraphMap: ParagraphMapEntry[];
}

/**
 * Converts HTML to narration-ready text with paragraph mapping.
 *
 * The client-side counterpart of the server's `htmlToNarrationInput`: the same
 * walk over the same elements, in the plain voice a TTS engine speaks verbatim
 * rather than the annotated one the LLM is fed.
 *
 * @example
 * const result = htmlToClientNarration('<p>Hello</p><img src="x" alt="photo">');
 * // result.narrationText: "Hello\n\nImage: photo"
 * // result.paragraphMap: [{ n: 0, o: 0 }, { n: 1, o: 1 }]
 */
export function htmlToClientNarration(html: string): ClientNarrationResult {
  return directNarration(parseBody(html));
}
