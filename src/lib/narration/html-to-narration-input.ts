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
import {
  BLOCK_ELEMENTS,
  containsNarrationBlock,
  isNarrationBlock,
  narrationBlocks,
} from "./block-elements";

// Re-export for backwards compatibility
export { BLOCK_ELEMENTS };

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
 * The list item a block belongs to, if any. Elements that narrate no paragraph
 * of their own — a `<div>` or `<section>` around the blocks — are transparent;
 * another block element does own its descendants.
 */
function enclosingListItem(el: Element): Element | null {
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const tagName = parent.tagName.toLowerCase();
    if (tagName === "li") return parent;
    if (tagName === "ul" || tagName === "ol") return null;
    if (isNarrationBlock(parent) && !isTransparentWrapper(parent)) return null;
  }
  return null;
}

/**
 * Whether a block says nothing of its own, so it owns none of its descendants:
 * a `<figure>` around a table announces no image, and the table is what speaks.
 *
 * Memoized for the same reason the marker handoff is: every block under a
 * figure asks this about it, and answering walks the figure.
 */
function isTransparentWrapper(el: Element): boolean {
  const cached = transparentWrappers.get(el);
  if (cached !== undefined) return cached;

  const transparent =
    el.tagName.toLowerCase() === "figure" && getOwnNarrationText(el).trim() === "";
  transparentWrappers.set(el, transparent);
  return transparent;
}

const transparentWrappers = new WeakMap<Element, boolean>();

/**
 * The block a list item hands its marker to, or null if nothing in it speaks.
 *
 * The *first* child is not good enough: a leading empty `<p>` narrates nothing,
 * and a nested list narrates only through its own items (which mark
 * themselves), so a marker parked on either is a marker lost — including the
 * task-list state from #1439, which is the item's only cue that it is done.
 */
function markerCarrier(li: Element, depth = 0): Element | null {
  if (depth >= MAX_CONTENT_DEPTH) return null;

  for (const child of Array.from(li.children)) {
    const tagName = child.tagName.toLowerCase();
    // A nested list's items carry their own markers, and a nested image is
    // spoken by the block around it rather than getting a paragraph.
    if (tagName === "ul" || tagName === "ol" || tagName === "img") continue;
    if (isNarrationBlock(child)) {
      if (getOwnNarrationText(child).trim() !== "") return child;
      if (!isTransparentWrapper(child)) continue;
    }
    // A wrapper is transparent — the block that speaks may be inside it.
    const nested = markerCarrier(child, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/**
 * The list marker a block inherits from the item that wraps it, if any.
 *
 * A loose list item (`<li><p>…</p></li>` — what cmark-gfm/GitHub emit for any
 * list with blank lines between items, so it is common in feed HTML) has no
 * text of its own; its children narrate themselves. The bullet and the spoken
 * checkbox state therefore ride along on one of those children instead of on
 * the item (issue #1441). An item that does have its own text speaks its own
 * marker, so its children inherit nothing.
 */
function inheritedListMarker(el: Element): string {
  const li = enclosingListItem(el);
  if (!li) return "";

  // Memoized: the answer depends only on the item, but the question is asked
  // once per block inside it, and answering walks the item — an item with a
  // few thousand paragraphs took seconds to narrate without this.
  let handoff = markerHandoffs.get(li);
  if (!handoff) {
    handoff =
      processInlineContent(li) !== ""
        ? { carrier: null, marker: "" }
        : { carrier: markerCarrier(li), marker: listItemMarker(li) };
    markerHandoffs.set(li, handoff);
  }
  return handoff.carrier === el ? handoff.marker : "";
}

/** Which block each list item hands its marker to — see `inheritedListMarker`. */
const markerHandoffs = new WeakMap<Element, { carrier: Element | null; marker: string }>();

/**
 * Blocks whose narration covers everything inside them, because their markers
 * wrap the text (`Quote: … End quote.`) and can't be split across children the
 * way a list item's bullet can.
 */
const SUBTREE_SPEAKERS = new Set(["blockquote", "pre", "table"]);

/**
 * Whether a block sits inside one that already speaks for it (issue #1445).
 */
function insideSubtreeSpeaker(el: Element): boolean {
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if (SUBTREE_SPEAKERS.has(parent.tagName.toLowerCase())) return true;
  }
  return false;
}

/**
 * Whether a figure narrates as the image it holds — as opposed to one around a
 * table or a list, which announces no image and is walked into like a wrapper.
 */
function speaksAsImage(el: Element): boolean {
  return el.tagName.toLowerCase() === "figure" && ownDescendant(el, "img") !== null;
}

/**
 * The first matching descendant an element speaks for itself — one no block in
 * between has already claimed.
 */
function ownDescendant(el: Element, selector: string): Element | null {
  for (const candidate of Array.from(el.querySelectorAll(selector))) {
    let owner: Element | null = null;
    for (let parent = candidate.parentElement; parent; parent = parent.parentElement) {
      if (isNarrationBlock(parent)) {
        owner = parent;
        break;
      }
    }
    if (owner === el) return candidate;
  }
  return null;
}

/**
 * How deep the content walk descends before flattening what is left.
 *
 * Nothing a listener can follow nests this far, and the walk is recursive over
 * feed-controlled markup — a document nesting thousands of quotes deep would
 * otherwise overflow the stack instead of being narrated.
 */
const MAX_CONTENT_DEPTH = 64;

/**
 * The paragraphs an element's content narrates as, in document order: inline
 * runs and block children interleaved the way they appear, so an attribution
 * that trails a quote is read after it rather than before it.
 */
function contentParagraphs(el: Element, depth = 0): string[] {
  if (depth >= MAX_CONTENT_DEPTH) {
    const text = el.textContent?.trim();
    return text ? [text] : [];
  }

  const paragraphs: string[] = [];
  let inline = "";

  const flushInline = () => {
    if (inline.trim()) paragraphs.push(inline.trim());
    inline = "";
  };

  el.childNodes.forEach((node) => {
    const child = node.nodeType === ELEMENT_NODE ? (node as Element) : null;
    const tagName = child?.tagName.toLowerCase() ?? "";
    const isBlock = child !== null && tagName !== "img" && isNarrationBlock(child);
    // A `<div>`/`<section>` around the blocks is transparent, but one that only
    // wraps inline markup is part of the run around it — as is an image, always.
    if (!child || (!isBlock && !containsNarrationBlock(child))) {
      inline += inlineNodeText(node);
      return;
    }

    flushInline();
    if (SUBTREE_SPEAKERS.has(tagName) || speaksAsImage(child)) {
      // Already speaks for everything below it, so don't descend twice.
      const text = getOwnNarrationText(child, depth + 1);
      if (text) paragraphs.push(text);
      return;
    }

    const inner = contentParagraphs(child, depth + 1);
    if (tagName === "li" && inner.length > 0) {
      inner[0] = `${listItemMarker(child)}${inner[0]}`;
    }
    paragraphs.push(...inner);
  });

  flushInline();
  return paragraphs;
}

/**
 * Converts an element's text content for narration.
 * Returns text in speakable form (no structural markers like [HEADING]).
 * Handles special elements like images, code blocks, etc.
 */
function getElementNarrationText(el: Element): string {
  // A block inside a quote or a table was narrated by that wrapper already;
  // narrating it again would speak the same words twice (issue #1445). It keeps
  // its paragraph index — which is what the client highlights by — and simply
  // contributes no paragraph, exactly like an empty element does.
  if (insideSubtreeSpeaker(el)) return "";

  const text = getOwnNarrationText(el);
  return text ? `${inheritedListMarker(el)}${text}` : "";
}

/**
 * The element's own narration text, before any marker it inherits from an
 * enclosing list item. `depth` is how far a wrapper's content walk has already
 * descended to reach this element (see `contentParagraphs`).
 */
function getOwnNarrationText(el: Element, depth = 0): string {
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

  // Handle blockquotes. Paragraphs inside the quote are kept apart by blank
  // lines rather than run together, and the player speaks each of them as its
  // own paragraph (all highlighting this blockquote).
  if (tagName === "blockquote") {
    const quoted = contentParagraphs(el, depth);
    return quoted.length > 0 ? `Quote: ${quoted.join("\n\n")} End quote.` : "";
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

  // Handle figures. Only what the figure itself holds: an image inside a
  // nested block (a table, a list) is spoken by that block instead — and a
  // figure around one of those is not an image at all, so it announces none.
  if (tagName === "figure") {
    if (!speaksAsImage(el)) {
      return processInlineContent(el);
    }
    const alt = ownDescendant(el, "img")?.getAttribute("alt")?.trim();
    const caption = ownDescendant(el, "figcaption")?.textContent?.trim();
    if (!alt) {
      // The caption is the only description there is.
      return `Image: ${caption || "no description"}`;
    }
    return caption ? `Image: ${alt}. ${caption}` : `Image: ${alt}`;
  }

  // Handle tables
  if (tagName === "table") {
    // Extract table content in a readable format. The caption and the cells
    // narrate the same way anything else does rather than through
    // `textContent`, because the blocks inside them stay silent for the
    // table's sake — so whatever they would have said (an image's alt text, a
    // list's bullets) has to be said here or it is said nowhere.
    const parts: string[] = [];
    const caption = el.querySelector("caption");
    if (caption?.closest("table") === el) {
      parts.push(contentParagraphs(caption, depth + 1).join(" "));
    }
    el.querySelectorAll("tr").forEach((tr) => {
      // A nested table narrates its own rows — as a cell of this one.
      if (tr.closest("table") !== el) return;
      const cells: string[] = [];
      tr.querySelectorAll("th, td").forEach((cell) => {
        if (cell.closest("tr") !== tr) return;
        cells.push(contentParagraphs(cell, depth + 1).join(" "));
      });
      if (cells.length > 0) {
        parts.push(cells.join(", "));
      }
    });
    return `Table: ${parts.filter(Boolean).join(". ")} End table.`;
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
 * Block children are left out: each narrates itself, so speaking them here too
 * would say the same words twice (issue #1441). An image is the exception — a
 * nested one gets no paragraph of its own, so the block around it speaks it.
 */
function processInlineContent(el: Element): string {
  return inlineChildrenText(el).trim();
}

/**
 * The inline text of an element's children, untrimmed — trimming at every level
 * of the walk swallows the space in `<b>Total:</b><span> 42</span>`.
 *
 * Depth-capped like the content walk, and for the same reason: the markup is
 * feed-controlled and nests as deeply as it likes.
 */
function inlineChildrenText(el: Element, depth = 0): string {
  if (depth >= MAX_CONTENT_DEPTH) {
    return el.textContent ?? "";
  }

  let text = "";
  el.childNodes.forEach((node) => {
    text += inlineNodeText(node, depth);
  });
  return text;
}

/**
 * What a node contributes to the inline run of text around it.
 */
function inlineNodeText(node: Node, depth = 0): string {
  if (node.nodeType === TEXT_NODE) {
    return node.textContent || "";
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return "";
  }

  const el = node as Element;
  const tagName = el.tagName.toLowerCase();

  if (tagName === "a") {
    // Handle links. Spoken untrimmed, so the space in `a<a href> b </a>c`
    // survives; the trimmed form is only for deciding what to say.
    const href = el.getAttribute("href");
    const raw = el.textContent || "";
    const linkText = raw.trim();

    if (!href) {
      // A link target (`<a id="fn1">`), not a link: it goes nowhere, so
      // announcing one would be noise — speak whatever text it wraps.
      return raw;
    }
    if (!linkText || linkText === href) {
      try {
        return `[link to ${new URL(href).hostname}]`;
      } catch {
        return `[link to ${href}]`;
      }
    }
    return raw;
  }

  if (tagName === "code") {
    // Inline code (empty markup is not worth speaking a pair of backticks)
    const code = el.textContent || "";
    return code ? `\`${code}\`` : "";
  }

  if (tagName === "img") {
    // Inline image. Padded because nothing guarantees whitespace around it —
    // a caption or a cell's text can butt right up against the alt text.
    return ` Image: ${el.getAttribute("alt") || "image"} `;
  }

  if (isNarrationBlock(el)) {
    return "";
  }

  // Recurse for other inline elements (strong, em, span, etc.) — and for a
  // wrapper around blocks, which narrates no paragraph of its own, so whatever
  // text it holds outside those blocks belongs to this run.
  return inlineChildrenText(el, depth + 1);
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

  // The blocks that narrate, in document order — the same list the client marks
  // with `data-para-id`, so index N means the same element on both sides.
  const combinedElements = narrationBlocks(doc.body);

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
  "dt",
  "dd",
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
