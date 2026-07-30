/**
 * The narration walk: how an entry's HTML becomes speech.
 *
 * Narration has to say every word of an entry exactly once, and point each
 * spoken paragraph at an element to highlight. Both come out of a single
 * depth-first walk that partitions the document's text into **runs**: a run is
 * a stretch of text with no block boundary in it, owned by the block that
 * encloses it.
 *
 * That partition is what makes coverage structural instead of rule-based. The
 * walk used to start from a list of elements that narrate and then decide, per
 * shape, who spoke for whom — so text in an element no rule claimed was
 * silently dropped, and text two rules claimed was said twice (issues #1441,
 * #1445, #1451). Here every text node lands in exactly one run, so a tag
 * classified wrongly moves a paragraph *boundary* rather than losing or
 * duplicating words.
 *
 * The two callers share this walk — the server turns runs into LLM input
 * (`./html-to-narration-input`), the client into text for the TTS engine plus
 * the `data-para-id`s it highlights against (`./client-paragraph-ids`) — so
 * they cannot drift apart structurally. They differ only in `NarrationVoice`.
 *
 * @module narration/runs
 */

import { isBlockTag, isNonProseTag, narrationTargets } from "./block-elements";

/**
 * What a narration path wants said out loud beyond the words themselves.
 *
 * The server's text is input to an LLM that rewrites it into a script, so it is
 * annotated: structure the model should phrase naturally, code it should read
 * as code. The client's text is spoken verbatim by a TTS engine, so it stays
 * plain. Keeping the difference in one object is what lets both paths share the
 * walk — and makes the divergence something you can see and change, rather than
 * two implementations that drifted.
 */
export interface NarrationVoice {
  /** Read `<pre>` contents aloud, rather than skipping code blocks entirely. */
  speakCodeBlocks: boolean;
  /** Announce structure: quote and table wrappers, list bullets, inline code. */
  structuralMarkers: boolean;
  /** Announce an image that has no alt text, which describes nothing. */
  speakUndescribedImages: boolean;
}

/** The annotated voice the narration LLM is fed. */
export const LLM_INPUT_VOICE: NarrationVoice = {
  speakCodeBlocks: true,
  structuralMarkers: true,
  speakUndescribedImages: true,
};

/** The plain voice a TTS engine speaks verbatim, with no LLM in the loop. */
export const DIRECT_TTS_VOICE: NarrationVoice = {
  speakCodeBlocks: false,
  structuralMarkers: false,
  speakUndescribedImages: false,
};

/** One spoken paragraph and the element it highlights. */
export interface NarrationRun {
  /**
   * Index of the element to highlight in `narrationTargets` — its
   * `data-para-id`. `-1` when the text has no element of its own (a bare run at
   * the top level of the document); it is still spoken, just not highlighted.
   */
  o: number;
  /** The text to narrate, already in speakable form. */
  text: string;
}

/**
 * Where a `<br><br>` ended a paragraph.
 *
 * A marker rather than a newline because source formatting must not break a
 * paragraph — a feed that wraps its `<p>` text at 72 columns means nothing by
 * it. A document can contain a raw NUL of its own (linkedom keeps one where a
 * browser drops it), so `appendWords` strips them rather than trusting that.
 */
const BREAK = "\u0000";

/** `Node.ELEMENT_NODE` etc., which linkedom doesn't expose as globals. */
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/**
 * How deep the walk descends before speaking what is left as one paragraph.
 *
 * Nothing a listener can follow nests this far, and the markup is
 * feed-controlled: a document nesting thousands of elements deep would
 * otherwise overflow the stack instead of being narrated.
 */
const MAX_DEPTH = 64;

/** What every level of the walk shares. */
interface WalkContext {
  voice: NarrationVoice;
  /** Element → its `data-para-id` number. */
  targets: Map<Element, number>;
  /**
   * Nodes an ancestor's own narration already covered — a figure's image and
   * caption. Shared across nested walks (a table's cells, a caption): a set per
   * walk would reset at those boundaries and say the image a second time.
   */
  consumed: Set<Node>;
}

/**
 * The paragraphs an element's content narrates as, in speech order.
 */
export function narrationRuns(root: Element, voice: NarrationVoice): NarrationRun[] {
  const targets = new Map<Element, number>();
  narrationTargets(root).forEach((el, index) => targets.set(el, index));
  return collectRuns(root, { voice, targets, consumed: new Set() }, 0);
}

function collectRuns(root: Element, ctx: WalkContext, depth: number): NarrationRun[] {
  const { voice, targets, consumed } = ctx;
  /** Runs as they accumulate, each still naming the element it highlights. */
  const runs: { highlight: Element; text: string }[] = [];

  /** The run being accumulated: its text, its owner, and what fed it. */
  let text = "";
  let owner: Element = root;
  let images = 0;
  let firstImage: Element | null = null;
  let spokeWords = false;
  /** How much of this run's subtree an ancestor's narration already claimed. */
  let claimed = 0;

  const push = (highlight: Element, value: string) => {
    // Two `<br>`s end a paragraph — with any amount of whitespace between them,
    // since `<br />\n<br />` is how feeds write it. Every other run of
    // whitespace, a single `<br>` included, is one space.
    for (const segment of value.replace(/\s*\u0000\s*/g, BREAK).split(/\u0000{2,}/)) {
      const paragraph = segment.replace(/[\s\u0000]+/g, " ").trim();
      if (paragraph) runs.push({ highlight, text: paragraph });
    }
  };

  const flush = () => {
    // An image alone in its run is highlighted as itself rather than as the
    // block around it: `<div><img></div>` is how most editors emit a standalone
    // image, and the highlight CSS has a border for exactly this case.
    const highlight = images === 1 && !spokeWords && firstImage ? firstImage : owner;
    push(highlight, text);
    text = "";
    images = 0;
    firstImage = null;
    spokeWords = false;
  };

  const appendWords = (value: string) => {
    // A raw NUL would fake a `<br><br>`, and the two parsers disagree about it
    // (linkedom keeps it where a browser drops it), so it never reaches a run.
    const words = value.includes(BREAK) ? value.replaceAll(BREAK, "") : value;
    text += words;
    if (words.trim()) spokeWords = true;
  };

  const appendImage = (img: Element) => {
    const value = imageText(img, voice);
    if (!value) return;
    images += 1;
    firstImage = images === 1 ? img : null;
    // Padded because nothing else guarantees a gap around the alt text: a
    // caption or a cell's words can butt right up against it.
    text += ` ${value} `;
  };

  /**
   * Wraps what a block emitted in the markers that announce it.
   *
   * They ride on the paragraphs rather than on the block because the block's
   * text may live entirely in the blocks inside it: a loose `<li><p>…</p></li>`
   * (what cmark-gfm and GitHub emit for any list with blank lines, so it is
   * common in feed HTML) has no text of its own to carry the bullet, and a
   * multi-paragraph quote has no one paragraph to wrap (issues #1441, #1445).
   */
  const markStructure = (el: Element, tagName: string, start: number) => {
    if (start >= runs.length) return;
    if (tagName === "li") {
      // Not necessarily the item's first paragraph: an item that opens with a
      // sublist would otherwise put its bullet on the sub-item's, which carries
      // its own — leaving the outer item's own text unmarked and the inner one
      // double-marked.
      const carrier = runs.findIndex(
        (run, index) => index >= start && !inNestedList(run.highlight, el)
      );
      if (carrier >= 0) runs[carrier].text = `${listItemMarker(el)}${runs[carrier].text}`;
    } else if (tagName === "blockquote") {
      runs[start].text = `Quote: ${runs[start].text}`;
      runs[runs.length - 1].text += " End quote.";
    }
  };

  const visitChildren = (el: Element, depth: number) => {
    el.childNodes.forEach((child) => visit(child, depth + 1));
  };

  const visitBlock = (el: Element, tagName: string, depth: number) => {
    flush();

    // Blocks that narrate their whole subtree, so the walk stops here: their
    // text is a formatted whole (a table's rows, a code listing) that can't be
    // assembled from the paragraphs inside it.
    if (tagName === "pre") {
      const code = flatText(el, voice, consumed).trim();
      if (voice.speakCodeBlocks && code) push(el, `Code block: ${code} End code block.`);
      return;
    }
    if (tagName === "table") {
      push(el, tableText(el, ctx, depth));
      return;
    }

    if (depth >= MAX_DEPTH) {
      push(el, flatText(el, voice, consumed));
      return;
    }

    // A figure speaks the image it holds together with the caption, which
    // describes that image and nothing else. Both are marked consumed and the
    // walk still descends, so anything else the figure holds — a long
    // description in its own `<p>` — is narrated rather than swallowed.
    const image = figureImage(el, tagName, consumed);
    if (image) {
      const caption = figurePart(el, "figcaption", consumed);
      consumed.add(image);
      if (caption) consumed.add(caption);
      push(el, figureText(image, caption, ctx, depth));
    }

    const start = runs.length;
    const enclosing = owner;
    owner = el;
    visitChildren(el, depth);
    flush();
    owner = enclosing;

    if (voice.structuralMarkers) markStructure(el, tagName, start);
  };

  /**
   * A link speaks the words it wraps. Only when it wraps nothing speakable — an
   * empty anchor, or the URL as its own text — does it announce where it goes
   * instead, because "[link to example.com]" beats silence but loses to words.
   *
   * Decided from what the walk produced rather than by looking for content
   * first: an image inside a link is content, and asking the DOM about it once
   * per link was the most expensive thing this walk did. "Produced" has to
   * include content an ancestor already claimed — the `<a>` around a figure's
   * image is the commonest markup there is, and the image is spoken, just not
   * here. It also means an image with no alt text leaves a link with nothing to
   * say, so the target is announced in the voice that skips such images and the
   * alt text is spoken in the voice that reads them.
   */
  const visitLink = (el: Element, depth: number) => {
    const href = el.getAttribute("href");
    const runsBefore = runs.length;
    const imagesBefore = images;
    const claimedBefore = claimed;
    const textBefore = text.length;

    if (depth >= MAX_DEPTH) appendWords(flatText(el, voice, consumed));
    else visitChildren(el, depth);

    // What it said, when all of that landed in the run being built. A block
    // inside the link (legal, and always says something) flushed instead.
    const flushed = runs.length !== runsBefore;
    const said = flushed ? null : text.slice(textBefore);
    if (flushed || images > imagesBefore || claimed > claimedBefore || (said ?? "").trim() !== "") {
      if (!href) return;
      // A URL as its own link text reads as noise; say where it goes instead.
      if (said !== null && said.trim() === href) {
        text = text.slice(0, textBefore);
        appendWords(linkTarget(href));
      } else if (flushed && runs.length === runsBefore + 1 && runs[runsBefore].text === href) {
        runs[runsBefore].text = linkTarget(href);
      }
      return;
    }
    if (href) appendWords(linkTarget(href));
  };

  const visitInline = (el: Element, tagName: string, depth: number) => {
    if (tagName === "img") {
      appendImage(el);
      return;
    }
    if (tagName === "br") {
      text += BREAK;
      return;
    }
    // An inert GFM task-list checkbox (issue #1439). It contributes no text of
    // its own; its item speaks the state, which is the only cue it carries.
    if (tagName === "input") return;
    if (tagName === "code" && voice.structuralMarkers) {
      // Wrapped after the fact rather than read from `textContent`, so whatever
      // is inside (an image's alt text) is still spoken.
      const before = text.length;
      const runsBefore = runs.length;
      visitChildren(el, depth);
      const code = text.slice(before).replaceAll(BREAK, " ");
      if (code.trim() && !code.includes("`") && runs.length === runsBefore) {
        text = `${text.slice(0, before)}\`${code.trim()}\``;
      }
      return;
    }
    if (tagName === "a") {
      visitLink(el, depth);
      return;
    }
    if (depth >= MAX_DEPTH) {
      appendWords(flatText(el, voice, consumed));
      return;
    }
    // Everything else is phrasing content (strong, em, span, math, …) and
    // continues the run of text around it.
    visitChildren(el, depth);
  };

  const visit = (node: Node, depth: number) => {
    if (consumed.has(node)) {
      claimed += 1;
      return;
    }
    if (node.nodeType === TEXT_NODE) {
      appendWords(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;

    const el = node as Element;
    const tagName = el.tagName.toLowerCase();
    if (isNonProseTag(tagName)) return;
    if (isBlockTag(tagName)) {
      visitBlock(el, tagName, depth);
      return;
    }
    visitInline(el, tagName, depth);
  };

  visitChildren(root, depth);
  flush();
  return runs.map((run) => ({ o: targets.get(run.highlight) ?? -1, text: run.text }));
}

/** Whether an element sits in a list nested inside the given list item. */
function inNestedList(el: Element, li: Element): boolean {
  for (let parent: Element | null = el; parent && parent !== li; parent = parent.parentElement) {
    const tagName = parent.tagName.toLowerCase();
    if (tagName === "ul" || tagName === "ol") return true;
  }
  return false;
}

/** The text of a subtree, as one string — the walk's output, joined. */
function subtreeText(el: Element, ctx: WalkContext, depth: number): string {
  return collectRuns(el, ctx, depth + 1)
    .map((run) => run.text)
    .join(" ");
}

/**
 * Everything an element holds, without descending: the walk's fallback at
 * `MAX_DEPTH`. Not `textContent`, which drops an image's alt text — and which
 * would read a code block aloud in the voice that skips them.
 */
function flatText(el: Element, voice: NarrationVoice, consumed: Set<Node>): string {
  const parts: string[] = [];
  const stack: Node[] = [el];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    if (consumed.has(node)) continue;
    if (node.nodeType === TEXT_NODE) {
      parts.push(node.textContent ?? "");
      continue;
    }
    if (node.nodeType !== ELEMENT_NODE) continue;

    const child = node as Element;
    const tagName = child.tagName.toLowerCase();
    if (isNonProseTag(tagName)) continue;
    if (tagName === "pre" && !voice.speakCodeBlocks) continue;
    if (tagName === "img") {
      parts.push(` ${imageText(child, voice)} `);
      continue;
    }
    // A line break separates words here as much as anywhere else, and this text
    // is spoken as one paragraph either way.
    if (tagName === "br") {
      parts.push(" ");
      continue;
    }
    const children = child.childNodes;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]);
    }
  }
  return parts.join("");
}

/**
 * A table reads as one paragraph: its caption, then its rows with the cells
 * joined by commas.
 *
 * Read by walking the table rather than by querying for rows and cells, so that
 * everything in it is covered: whatever an author (or a Markdown renderer) put
 * outside the structure is narrated where it sits instead of nowhere. Cells
 * narrate through the walk too — flattening them to `textContent` would drop the
 * alt text of an image in a cell and the bullets of a list in one (issue #1445).
 */
function tableText(el: Element, ctx: WalkContext, depth: number): string {
  const parts: string[] = [];

  const readRow = (tr: Element): string => {
    const cells: string[] = [];
    tr.childNodes.forEach((node) => {
      if (node.nodeType === TEXT_NODE) {
        cells.push((node.textContent ?? "").trim());
        return;
      }
      if (node.nodeType !== ELEMENT_NODE) return;
      // A `th`/`td`, or whatever else ended up in the row.
      cells.push(nodeText(node as Element, ctx, depth));
    });
    return cells.filter((cell) => cell.trim()).join(", ");
  };

  const read = (parent: Element) => {
    parent.childNodes.forEach((node) => {
      if (node.nodeType === TEXT_NODE) {
        parts.push((node.textContent ?? "").trim());
        return;
      }
      if (node.nodeType !== ELEMENT_NODE) return;

      const child = node as Element;
      const tagName = child.tagName.toLowerCase();
      if (tagName === "tr") {
        parts.push(readRow(child));
        return;
      }
      // A row group holds rows; anything else (the caption, a stray block) is
      // read where it sits.
      if (tagName === "thead" || tagName === "tbody" || tagName === "tfoot") {
        read(child);
        return;
      }
      parts.push(nodeText(child, ctx, depth));
    });
  };
  read(el);

  const rows = parts.filter((part) => part.trim()).join(". ");
  if (!rows) return "";
  return ctx.voice.structuralMarkers ? `Table: ${rows} End table.` : rows;
}

/** What an element inside a table's structure contributes. */
function nodeText(el: Element, ctx: WalkContext, depth: number): string {
  const tagName = el.tagName.toLowerCase();
  // Checked here as well as in the walk: a table reads its children as roots of
  // their own sub-walk, which is not a path `visit` sees.
  if (isNonProseTag(tagName)) return "";
  // An image speaks for itself; everything else speaks through its contents.
  return tagName === "img" ? imageText(el, ctx.voice) : subtreeText(el, ctx, depth).trim();
}

/** The image a figure narrates as, if it is a figure and it holds one. */
function figureImage(el: Element, tagName: string, consumed: Set<Node>): Element | null {
  return tagName === "figure" ? figurePart(el, "img", consumed) : null;
}

/**
 * Blocks a figure cannot speak through, because they narrate their own subtree:
 * a table reads its cells, a code block its listing, a nested figure its own
 * image, and a `<figcaption>` is a caption in its own right. Reaching past one
 * would say its contents twice.
 */
const OWN_NARRATION = new Set(["table", "pre", "figure", "figcaption"]);

/**
 * The image or caption a figure speaks for: the first one it holds through
 * wrappers that say nothing of their own (`<figure><div><img></div>` — what
 * WordPress-style editors emit).
 *
 * A wrapper that has text of its own keeps what it holds, because the figure
 * speaking for it would leave that text narrated twice or not at all.
 */
function figurePart(el: Element, selector: string, consumed: Set<Node>): Element | null {
  for (const candidate of Array.from(el.querySelectorAll(selector))) {
    if (consumed.has(candidate)) continue;
    const own = (candidate.textContent ?? "").trim();
    let held = true;
    for (
      let parent = candidate.parentElement;
      parent && parent !== el;
      parent = parent.parentElement
    ) {
      if (
        OWN_NARRATION.has(parent.tagName.toLowerCase()) ||
        (parent.textContent ?? "").trim() !== own
      ) {
        held = false;
        break;
      }
    }
    if (held) return candidate;
  }
  return null;
}

/**
 * A figure's image with the caption nothing else narrates: the caption is the
 * description when there is no alt text, and extra detail when there is.
 */
function figureText(
  image: Element,
  caption: Element | null,
  ctx: WalkContext,
  depth: number
): string {
  const alt = image.getAttribute("alt")?.trim();
  const captionText = caption ? subtreeText(caption, ctx, depth).trim() : "";
  if (alt) {
    return captionText ? `Image: ${alt}. ${captionText}` : `Image: ${alt}`;
  }
  if (captionText) {
    // The caption is the only description there is.
    return `Image: ${captionText}`;
  }
  return ctx.voice.speakUndescribedImages ? "Image: no description" : "";
}

/** What an image contributes to the run it sits in. */
function imageText(img: Element, voice: NarrationVoice): string {
  const alt = img.getAttribute("alt")?.trim();
  if (alt) return `Image: ${alt}`;
  return voice.speakUndescribedImages ? "Image: image" : "";
}

/** How a link with no words of its own announces where it goes. */
function linkTarget(href: string): string {
  try {
    return `[link to ${new URL(href).hostname}]`;
  } catch {
    return `[link to ${href}]`;
  }
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
    if (node.nodeType !== ELEMENT_NODE) continue;
    return node as Element;
  }
  return null;
}
