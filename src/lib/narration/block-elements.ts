/**
 * Shared block element definitions for narration.
 *
 * This module is isomorphic (works in both browser and server)
 * and provides the canonical list of block elements for paragraph marking.
 *
 * @module narration/block-elements
 */

/**
 * Block-level elements that get paragraph markers for narration highlighting.
 * Used by both server-side preprocessing and client-side highlighting.
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
  "dl",
  "dt",
  "dd",
  "figure",
  "table",
  "img",
] as const;

/**
 * Type for block element tag names.
 */
export type BlockElement = (typeof BLOCK_ELEMENTS)[number];

/**
 * Generic containers that narrate as a paragraph only when nothing inside them
 * narrates already — see `wrapperSpeaks` for the rule (issue #1451).
 *
 * Most of them are structural — a `<div>` around the whole article, a
 * `<section>` around its own `<p>`s — and giving those a paragraph would say
 * everything inside them a second time. But an editor that emits
 * `<div>Some text</div>` where it should emit a `<p>` is common in feed HTML,
 * and text like that is narrated nowhere unless the container speaks it.
 */
const WRAPPER_ELEMENTS = [
  "div",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "main",
  "nav",
] as const;

const BLOCK_ELEMENTS_SET = new Set<string>(BLOCK_ELEMENTS);
const WRAPPER_ELEMENTS_SET = new Set<string>(WRAPPER_ELEMENTS);

/** Everything that can narrate as a paragraph, images included. */
const ANY_BLOCK_SELECTOR = [...BLOCK_ELEMENTS, ...WRAPPER_ELEMENTS].join(", ");

/** The same, minus images: a nested image never gets a paragraph of its own. */
const NESTED_BLOCK_SELECTOR = [...BLOCK_ELEMENTS, ...WRAPPER_ELEMENTS]
  .filter((tagName) => tagName !== "img")
  .join(", ");

/**
 * Whether an element narrates as a paragraph of its own.
 *
 * An image counts here, but only the standalone ones become paragraphs — see
 * `narrationBlocks`.
 *
 * Memoized because the walks ask this about the same wrapper repeatedly and
 * answering it scans the wrapper's subtree.
 */
export function isNarrationBlock(el: Element): boolean {
  const tagName = el.tagName.toLowerCase();
  if (BLOCK_ELEMENTS_SET.has(tagName)) return true;
  if (!WRAPPER_ELEMENTS_SET.has(tagName)) return false;

  const cached = speakingWrappers.get(el);
  if (cached !== undefined) return cached;
  const speaks = wrapperSpeaks(el);
  speakingWrappers.set(el, speaks);
  return speaks;
}

/** Which wrappers narrate as a paragraph — see `isNarrationBlock`. */
const speakingWrappers = new WeakMap<Element, boolean>();

/** Whether a wrapper narrates a paragraph rather than being walked through. */
function wrapperSpeaks(el: Element): boolean {
  // A block inside it narrates itself, so this wrapper is structural.
  if (containsNarrationBlock(el)) return false;
  // Nothing but images: each of those is a paragraph of its own, and speaking
  // them here too would say the alt text twice — `<div><img></div>` is how most
  // editors emit a standalone image. Unless there is text alongside them, which
  // nothing else would narrate: then this wrapper reads as the whole run.
  return el.querySelector("img") === null || (el.textContent ?? "").trim() !== "";
}

/**
 * Whether an element holds a block that narrates itself, which makes the
 * element around it a wrapper to be walked into rather than a run of text.
 */
export function containsNarrationBlock(el: Element): boolean {
  return el.querySelector(NESTED_BLOCK_SELECTOR) !== null;
}

/**
 * The elements that narrate as paragraphs, in document order.
 *
 * This is the one list both sides of narration are built from — the server's
 * narration input and the client's `data-para-id` assignment — so that a
 * paragraph index means the same element in both. `root` bounds the walk (the
 * `<body>` server-side, the wrapper the HTML was parsed into client-side).
 */
export function narrationBlocks(root: Element): Element[] {
  return Array.from(root.querySelectorAll(ANY_BLOCK_SELECTOR)).filter((el) => {
    if (!isNarrationBlock(el)) return false;
    if (el.tagName.toLowerCase() !== "img") return true;
    // An image is a paragraph only when it is standalone: a block around it
    // speaks it instead (a figure's alt text, a table's cell, a paragraph's run
    // of text), so a second paragraph here would repeat the alt text.
    for (let parent = el.parentElement; parent && parent !== root; parent = parent.parentElement) {
      if (isNarrationBlock(parent)) return false;
    }
    return true;
  });
}
