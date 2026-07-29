/**
 * HTML to Narration Input Converter
 *
 * This module converts HTML content to structured text with paragraph markers
 * for LLM processing. Uses DOM parsing to ensure paragraph indices match
 * the client-side highlighting implementation.
 *
 * @module narration/html-to-narration-input
 */

import { parseHTML } from "linkedom";
import { BLOCK_ELEMENTS } from "./block-elements";

// Re-export for backwards compatibility
export { BLOCK_ELEMENTS };

/**
 * Set version of BLOCK_ELEMENTS for efficient lookup.
 */
const BLOCK_ELEMENTS_SET = new Set<string>(BLOCK_ELEMENTS);

/** `Node.ELEMENT_NODE` etc., which linkedom doesn't expose as globals. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;

/**
 * A paragraph in the narration input, ready to be sent to LLM as JSON.
 */
export interface NarrationInputParagraph {
  /** Paragraph index (0-based) */
  id: number;
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
 * The element a node's content starts with, or null when text comes first.
 * Not `firstElementChild`, which skips over text: `<li>see <input>` must not
 * count as starting with the `<input>`.
 */
function leadingElement(parent: Element): Element | null {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === TEXT_NODE) {
      if ((node.textContent ?? "").trim() === "") continue;
      return null;
    }
    if (node.nodeType === COMMENT_NODE) continue;
    return node.nodeType === ELEMENT_NODE ? (node as Element) : null;
  }
  return null;
}

/**
 * The GFM task-list checkbox a list item leads with, if it has one.
 *
 * Renderers put it in one of two places: directly in the `<li>` (a tight list,
 * what our Markdown renderer emits) or inside the item's first `<p>` (a loose
 * list, what cmark-gfm/GitHub emit). Walked rather than matched with a `:scope`
 * selector so it can't reach into a nested list's items.
 */
function leadingTaskCheckbox(li: Element): Element | null {
  const first = leadingElement(li);
  const candidate = first?.tagName.toLowerCase() === "p" ? leadingElement(first) : first;
  return candidate?.tagName.toLowerCase() === "input" &&
    candidate.getAttribute("type")?.toLowerCase() === "checkbox"
    ? candidate
    : null;
}

/**
 * Whether an element narrates itself, so an enclosing block must leave its text
 * out — otherwise the same words are spoken twice (issue #1441).
 *
 * `img` is the exception: an image nested inside a block element is dropped from
 * the paragraph list below, so the enclosing block is what speaks its alt text.
 */
function narratesItself(el: Element): boolean {
  const tagName = el.tagName.toLowerCase();
  return tagName !== "img" && BLOCK_ELEMENTS_SET.has(tagName);
}

/**
 * The bullet a list item is read with, plus its task-list state when it leads
 * with a checkbox. A task list carries that state in the checkbox, which
 * contributes no text — so read aloud, a done item would be indistinguishable
 * from a not-done one (the narration half of issue #1439). Speak the state.
 */
function listItemMarker(li: Element): string {
  const checkbox = leadingTaskCheckbox(li);
  if (!checkbox) {
    return "- ";
  }
  return `- ${checkbox.hasAttribute("checked") ? "Done" : "Not done"}: `;
}

/**
 * The list marker a block inherits from the item that wraps it, if any.
 *
 * A loose list item (`<li><p>…</p></li>` — what cmark-gfm/GitHub emit for any
 * list with blank lines between items, so it is common in feed HTML) has no
 * text of its own; its children narrate themselves. The bullet and the spoken
 * checkbox state therefore ride along on the first of those children instead of
 * on the item (issue #1441). An item that does have its own text speaks its own
 * marker, so its children inherit nothing.
 */
function inheritedListMarker(el: Element): string {
  const li = el.parentElement;
  if (!li || li.tagName.toLowerCase() !== "li") return "";
  if (leadingElement(li) !== el) return "";
  if (processInlineContent(li) !== "") return "";
  return listItemMarker(li);
}

/**
 * Converts an element's text content for narration.
 * Returns text in speakable form (no structural markers like [HEADING]).
 * Handles special elements like images, code blocks, etc.
 */
function getElementNarrationText(el: Element): string {
  const text = getOwnNarrationText(el);
  return text ? `${inheritedListMarker(el)}${text}` : "";
}

/**
 * The element's own narration text, before any marker it inherits from an
 * enclosing list item.
 */
function getOwnNarrationText(el: Element): string {
  const tagName = el.tagName.toLowerCase();

  // Handle headings - just return the text (no marker)
  if (
    tagName === "h1" ||
    tagName === "h2" ||
    tagName === "h3" ||
    tagName === "h4" ||
    tagName === "h5" ||
    tagName === "h6"
  ) {
    return el.textContent?.trim() || "";
  }

  // Handle code blocks
  if (tagName === "pre") {
    const codeContent = el.textContent?.trim() || "";
    return `Code block: ${codeContent} End code block.`;
  }

  // Handle blockquotes
  if (tagName === "blockquote") {
    return `Quote: ${el.textContent?.trim() || ""} End quote.`;
  }

  // Handle lists (ul/ol don't have their own text - skip)
  if (tagName === "ul" || tagName === "ol") {
    return "";
  }

  // Handle list items. Only the item's own text: block children (a loose list's
  // paragraphs, a nested list) narrate themselves, and one of them carries the
  // marker when the item has no text of its own — see `inheritedListMarker`.
  if (tagName === "li") {
    const text = processInlineContent(el);
    return text ? `${listItemMarker(el)}${text}` : "";
  }

  // Handle figures
  if (tagName === "figure") {
    const img = el.querySelector("img");
    const figcaption = el.querySelector("figcaption");
    const alt = img?.getAttribute("alt") || figcaption?.textContent?.trim() || "no description";
    return `Image: ${alt}`;
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
        rows.push(cells.join(", "));
      }
    });
    return `Table: ${rows.join(". ")} End table.`;
  }

  // Handle standalone images
  if (tagName === "img") {
    const alt = el.getAttribute("alt") || "image";
    return `Image: ${alt}`;
  }

  // Handle regular paragraphs - process links and inline elements
  return processInlineContent(el);
}

/**
 * Process inline content, handling links and other inline elements.
 *
 * Block children are left out — see `narratesItself`.
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
        text += `Image: ${alt}`;
      } else if (!narratesItself(childEl)) {
        // Recurse for other inline elements (strong, em, span, etc.)
        text += processInlineContent(childEl);
      }
    }
  });

  return text.trim();
}

/**
 * Converts HTML to structured paragraphs for LLM processing.
 * Uses DOM parsing to ensure paragraph indices are assigned in document order,
 * matching the client-side paragraph ID assignment.
 *
 * Returns an array of paragraphs with IDs and text in speakable form.
 * The LLM will use these IDs in [PARA:X] markers in its output for highlighting support.
 *
 * @param html - HTML content to convert
 * @returns Object with paragraphs array (id and text for each paragraph)
 *
 * @example
 * const result = htmlToNarrationInput('<h2>Title</h2><p>Content</p>');
 * // Returns {
 * //   paragraphs: [
 * //     { id: 0, text: "Title" },
 * //     { id: 1, text: "Content" }
 * //   ]
 * // }
 */
export function htmlToNarrationInput(html: string): HtmlToNarrationInputResult {
  // Handle empty input
  if (!html || html.trim() === "") {
    return {
      paragraphs: [],
    };
  }

  // Parse HTML using linkedom (faster than JSDOM)
  // Wrap in a full HTML document structure for proper parsing
  const { document: doc } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);

  // Build selector for all block elements (including img)
  const selector = Array.from(BLOCK_ELEMENTS).join(", ");

  // Find all block elements in document order
  // querySelectorAll returns elements in document order, so no sorting needed
  const allElements = doc.querySelectorAll(selector);

  // Filter to skip non-standalone images (images inside other block elements like figure)
  // An image is standalone if none of its ancestors are block elements
  const combinedElements = Array.from(allElements).filter((el) => {
    if (el.tagName.toLowerCase() !== "img") {
      return true; // Keep all non-img elements
    }

    // For img elements, check if they are standalone
    let parent = el.parentElement;
    while (parent && parent !== doc.body) {
      const parentTag = parent.tagName.toLowerCase();
      if (BLOCK_ELEMENTS_SET.has(parentTag)) {
        return false; // Skip - img is inside another block element
      }
      parent = parent.parentElement;
    }
    return true; // Standalone img
  });

  const paragraphs: NarrationInputParagraph[] = [];

  combinedElements.forEach((el, index) => {
    const text = getElementNarrationText(el);

    // Normalize whitespace
    const normalizedText = text
      .replace(/\u00A0/g, " ") // Convert nbsp to regular space
      .replace(/ +/g, " ") // Collapse multiple spaces
      .trim();

    // Filter out empty paragraphs
    if (normalizedText) {
      paragraphs.push({
        id: index,
        text: normalizedText,
      });
    }
  });

  return {
    paragraphs,
  };
}

/**
 * Block elements that should have paragraph breaks before them.
 */
const BLOCK_TAGS_FOR_PLAIN_TEXT = new Set([
  "p",
  "div",
  "br",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "tr",
  "blockquote",
  "pre",
  "figure",
  "table",
]);

/**
 * Converts HTML to plain text for fallback mode.
 * Uses linkedom for proper HTML parsing.
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
      if (BLOCK_TAGS_FOR_PLAIN_TEXT.has(tagName)) {
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
    .replace(/\u00A0/g, " ") // Convert nbsp to regular space
    .replace(/ +/g, " ") // Collapse multiple spaces
    .replace(/\n{3,}/g, "\n\n") // Collapse multiple newlines
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}
