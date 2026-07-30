/**
 * Which HTML elements are blocks, and which ones narration can highlight.
 *
 * This module is isomorphic (it works against a linkedom document server-side
 * and a `DOMParser` one in the browser) and is the structural half of
 * narration: it says where a stretch of speech ends and what can carry a
 * `data-para-id`. What the speech *says* is `./runs`.
 *
 * @module narration/block-elements
 */

/**
 * Elements that break a run of text, and can therefore own a spoken paragraph.
 *
 * Everything not listed is treated as phrasing content — it joins the run of
 * text around it. That default is deliberate: a block we forget to list only
 * merges its text into the neighbouring paragraph, whereas an inline element
 * misfiled as a block would chop a sentence into paragraphs mid-clause. The
 * list is closed because sanitization is (`native/sanitizer/core/src/sanitize.rs`
 * `ALLOWED_TAGS`), so anything reaching us that isn't here is phrasing, a
 * MathML tag, or a media element.
 *
 * A table's own structure (`tr`, `td`, `caption`, …) is absent on purpose: a
 * table narrates its whole subtree in one paragraph, so the walk never
 * descends into those and they can neither break a run nor own one.
 */
const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "div",
  "section",
  "article",
  "aside",
  "header",
  "footer",
  "main",
  "nav",
  "blockquote",
  "pre",
  "figure",
  "figcaption",
  "details",
  "summary",
  "address",
  "hr",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
]);

/** Whether a tag name breaks a run of text — see `BLOCK_TAGS`. */
export function isBlockTag(tagName: string): boolean {
  return BLOCK_TAGS.has(tagName);
}

/**
 * Elements whose content is not prose: narration neither speaks it nor numbers
 * anything inside it.
 *
 * Entry HTML is sanitized before narration and sanitization drops these with
 * their content (`DROP_WITH_CONTENT` in `native/sanitizer/core/src/sanitize.rs`),
 * but narration does not lean on that — a stylesheet or a script read aloud is a
 * bad enough failure to refuse twice. Unlike the sanitizer's list, this one is
 * about speech: `option` and `title` hold words nobody is reading the article
 * for.
 */
const NON_PROSE = new Set([
  "script",
  "style",
  "textarea",
  "option",
  "title",
  "noscript",
  "noembed",
  "noframes",
  "xmp",
  "plaintext",
  "annotation",
  "annotation-xml",
]);

/** Whether a tag name holds something other than prose — see `NON_PROSE`. */
export function isNonProseTag(tagName: string): boolean {
  return NON_PROSE.has(tagName);
}

/**
 * Whether an element can carry a `data-para-id`: the blocks, plus images (an
 * image alone in its run is highlighted as itself rather than as the block
 * around it).
 */
function isTarget(tagName: string): boolean {
  return BLOCK_TAGS.has(tagName) || tagName === "img";
}

/**
 * The elements narration can highlight, in document order — their positions are
 * the `data-para-id` numbers, and what a run's `o` indexes into.
 *
 * The server (deriving narration) and the client (stamping the attributes) both
 * number elements with this one function, which is what makes an `o` mean the
 * same element on both sides. It is deliberately a plain structural walk: no
 * element is filtered out for saying nothing, so the numbering is a property of
 * the tree alone — the same whichever voice narrates it, and stable for as long
 * as a cached paragraph map refers to it. (Which numbered element a given run
 * *picks* does depend on what spoke; only the numbering itself is fixed.)
 * Elements that never own a run simply keep an id nothing highlights.
 *
 * Changing what this numbers — or what `./runs` says — invalidates every cached
 * paragraph map, so it comes with a `NARRATION_FORMAT_VERSION` bump
 * (`./constants`).
 */
export function narrationTargets(root: Element): Element[] {
  const targets: Element[] = [];

  // Walked with an explicit stack rather than a selector or recursion: entry
  // HTML is feed-controlled, and a union selector over a deeply nested document
  // is quadratic in some DOM implementations (seconds under jsdom) while
  // recursion would overflow on the same input.
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const el = stack.pop() as Element;
    const tagName = el.tagName.toLowerCase();
    if (el !== root && isNonProseTag(tagName)) continue;
    if (el !== root && isTarget(tagName)) targets.push(el);
    const children = el.children;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
  return targets;
}
