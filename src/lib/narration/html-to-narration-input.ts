/**
 * HTML to narration input, server-side.
 *
 * Turns entry HTML into the numbered paragraphs the narration LLM rewrites into
 * a script. The paragraphs come from the shared walk in `./runs` — the same one
 * the client uses — so a paragraph's `o` names the element the client marked
 * with `data-para-id="para-{o}"` and highlighting stays in step.
 *
 * The HTML must be **sanitized** first (the caller's job): the raw columns hold
 * markup the page never renders, and narrating those numbers elements the client
 * never marks.
 *
 * @module narration/html-to-narration-input
 */

import { parseBodyAsBrowser } from "./parse-html";
import { LLM_INPUT_VOICE, narrationRuns } from "./runs";

/**
 * A paragraph in the narration input, ready to be sent to the LLM as JSON.
 */
export interface NarrationInputParagraph {
  /** Paragraph id: what the LLM echoes back to say which paragraph it rewrote. */
  id: number;
  /**
   * The element this paragraph highlights, as its `data-para-id` number, or -1
   * when the text has no element of its own. Distinct from `id`: several
   * paragraphs can share one element (loose text either side of a nested block).
   */
  o: number;
  /** The text to narrate, already in speakable form */
  text: string;
}

/**
 * Result of converting HTML to narration input.
 */
export interface HtmlToNarrationInputResult {
  /** Array of paragraphs with IDs and text */
  paragraphs: NarrationInputParagraph[];
}

/**
 * Converts HTML to numbered paragraphs for the narration LLM.
 *
 * @param html - HTML content to convert
 * @returns Object with paragraphs array (id, highlight target and text for each)
 *
 * @example
 * const result = htmlToNarrationInput('<h2>Title</h2><p>Content</p>');
 * // Returns {
 * //   paragraphs: [
 * //     { id: 0, o: 0, text: "Title" },
 * //     { id: 1, o: 1, text: "Content" }
 * //   ]
 * // }
 */
export function htmlToNarrationInput(html: string): HtmlToNarrationInputResult {
  if (!html || html.trim() === "") {
    return { paragraphs: [] };
  }

  // Parsed into the tree a browser builds, which is the one the client numbers
  // against (see `./parse-html`).
  const body = parseBodyAsBrowser(html);

  return {
    paragraphs: narrationRuns(body, LLM_INPUT_VOICE).map((run, index) => ({
      id: index,
      o: run.o,
      text: run.text,
    })),
  };
}
