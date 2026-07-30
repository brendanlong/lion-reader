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

import { parseHTML } from "linkedom";
import { isBlockTag } from "./block-elements";
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

  // linkedom is faster than JSDOM; wrap the fragment so it parses as a document.
  const { document: doc } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);

  return {
    paragraphs: narrationRuns(doc.body, LLM_INPUT_VOICE).map((run, index) => ({
      id: index,
      o: run.o,
      text: run.text,
    })),
  };
}

/**
 * Tags that break a line in plain text without being narration blocks: a table
 * row (the narration walk never descends into a table, but a summary should see
 * one row per line) and an explicit line break.
 */
const PLAIN_TEXT_BREAKS = new Set(["br", "tr"]);

/**
 * Converts HTML to plain text (for AI summarization, which wants the words with
 * no narration conventions layered on top).
 *
 * @param html - HTML content to convert
 * @returns Plain text with paragraph breaks
 *
 * @example
 * const text = htmlToPlainText('<p>Hello</p><p>World</p>');
 * // Returns "Hello\n\nWorld"
 */
export function htmlToPlainText(html: string): string {
  if (!html || html.trim() === "") {
    return "";
  }

  // Wrap in a full HTML document structure for proper parsing
  const { document: doc } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);

  // Process the document to build plain text
  const parts: string[] = [];

  function processNode(node: Node): void {
    if (node.nodeType === 3) {
      // Text node
      const text = node.textContent || "";
      if (text.trim()) {
        parts.push(text);
      }
    } else if (node.nodeType === 1) {
      // Element node
      const el = node as Element;
      const tagName = el.tagName.toLowerCase();

      // Add paragraph break before block elements
      if (isBlockTag(tagName) || PLAIN_TEXT_BREAKS.has(tagName)) {
        parts.push("\n\n");
      }

      // Handle images - extract alt text
      if (tagName === "img") {
        const alt = el.getAttribute("alt");
        if (alt) {
          parts.push(`\n\nImage: ${alt}\n\n`);
        } else {
          parts.push("\n\nImage\n\n");
        }
        return;
      }

      // Recursively process child nodes
      el.childNodes.forEach((child) => processNode(child));
    }
  }

  processNode(doc.body);

  // Join and normalize the text
  return parts
    .join("")
    .replace(/ /g, " ") // Convert nbsp to regular space
    .replace(/ +/g, " ") // Collapse multiple spaces
    .replace(/\n{3,}/g, "\n\n") // Collapse multiple newlines
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}
