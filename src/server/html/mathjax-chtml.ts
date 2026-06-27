/**
 * Convert MathJax v3 CommonHTML (CHTML) output back into presentation MathML.
 *
 * Some sources (notably LessWrong) deliver math pre-rendered as MathJax CHTML
 * rather than as MathML or LaTeX: a tree of custom `<mjx-*>` elements plus a
 * sibling `<style>` block, where each glyph is an *empty* `<mjx-c class="mjx-c1D465 …">`
 * element whose visible character comes from CSS (the codepoint is encoded in the
 * class name, e.g. `mjx-c1D465` → U+1D465 `𝑥`).
 *
 * Our entry sanitizer (`sanitize.ts`) intentionally drops `<style>` and any tag
 * not on its allow-list, and `<mjx-*>` tags are not allowed. Because the glyphs
 * live in CSS rather than in text nodes, stripping the CSS *and* the `<mjx-*>`
 * elements makes the math vanish entirely — the symptom users see is sentences
 * with all the variables missing.
 *
 * MathML *is* on the sanitizer allow-list and renders natively in modern
 * browsers (MathML Core, no JS), so we convert the CHTML tree to MathML before
 * sanitization. The conversion is keyed off the semantic `<mjx-*>` wrapper names
 * MathJax emits; unrecognized wrappers are unwrapped so their inner tokens still
 * survive (lossy but readable) rather than being dropped.
 *
 * This runs inside `sanitizeEntryHtml`, so its output is covered by the same
 * persisted-sanitized-content cache; bump `SANITIZER_VERSION` when changing it.
 */

import { parseHTML } from "linkedom";

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

// MathJax token elements → MathML token elements. These hold the actual glyphs
// (as nested <mjx-c>), so we flatten their codepoints into text content rather
// than recursing structurally.
const TOKEN_TAGS: Record<string, string> = {
  "mjx-mi": "mi",
  "mjx-mo": "mo",
  "mjx-mn": "mn",
  "mjx-ms": "ms",
  "mjx-mtext": "mtext",
};

/** Extract the Unicode character a single `<mjx-c>` element represents. */
function codepointChar(el: Element): string {
  const cls = el.getAttribute("class") ?? "";
  const match = cls.match(/\bmjx-c([0-9A-Fa-f]{2,6})\b/);
  if (!match) return "";
  try {
    return String.fromCodePoint(parseInt(match[1], 16));
  } catch {
    return "";
  }
}

/**
 * Collect the text of a token element by concatenating every descendant
 * `<mjx-c>` codepoint (handles multi-character identifiers like `log`). For
 * stretchy operators MathJax decomposes the glyph into assembly pieces
 * (`<mjx-stretchy-v>`/`<mjx-stretchy-h>` → beg/ext/end); emitting all of those
 * would produce garbage, so we keep only the first piece's character.
 */
function tokenText(el: Element): string {
  const stretchy = el.querySelector("mjx-stretchy-v, mjx-stretchy-h");
  const glyphs = el.querySelectorAll("mjx-c");
  if (stretchy && glyphs.length > 0) {
    return codepointChar(glyphs[0]);
  }
  let text = "";
  for (const glyph of glyphs) text += codepointChar(glyph);
  return text;
}

/** Convert every element child of `parent`, appending results to `out`. */
function convertChildren(parent: Element, doc: Document, out: Node[]): void {
  for (const child of parent.childNodes) {
    if (child.nodeType === 1) convertElement(child as Element, doc, out);
  }
}

/** Wrap a node list as a single MathML node (an <mrow> when there are 0 or >1). */
function groupNodes(nodes: Node[], doc: Document): Node {
  if (nodes.length === 1) return nodes[0];
  const mrow = doc.createElement("mrow");
  for (const node of nodes) mrow.appendChild(node);
  return mrow;
}

/** Convert the children of `parent` and wrap them as a single MathML node. */
function convertGroup(parent: Element | null, doc: Document): Node {
  const nodes: Node[] = [];
  if (parent) convertChildren(parent, doc, nodes);
  return groupNodes(nodes, doc);
}

function convertElement(el: Element, doc: Document, out: Node[]): void {
  const tag = el.tagName.toLowerCase();

  if (tag === "mjx-c") {
    out.push(doc.createTextNode(codepointChar(el)));
    return;
  }

  const tokenTag = TOKEN_TAGS[tag];
  if (tokenTag) {
    const node = doc.createElement(tokenTag);
    node.textContent = tokenText(el);
    out.push(node);
    return;
  }

  // texatom and mrow are plain horizontal groupings.
  if (tag === "mjx-texatom" || tag === "mjx-mrow") {
    const mrow = doc.createElement("mrow");
    const nodes: Node[] = [];
    convertChildren(el, doc, nodes);
    for (const node of nodes) mrow.appendChild(node);
    out.push(mrow);
    return;
  }

  // Sub/superscripts: CHTML lays out [base …, <mjx-script>script</mjx-script>].
  if (tag === "mjx-msup" || tag === "mjx-msub") {
    const baseNodes: Node[] = [];
    let scriptParent: Element | null = null;
    for (const child of el.childNodes) {
      if (child.nodeType !== 1) continue;
      const childEl = child as Element;
      if (childEl.tagName.toLowerCase() === "mjx-script") scriptParent = childEl;
      else convertElement(childEl, doc, baseNodes);
    }
    const node = doc.createElement(tag.slice(4)); // mjx-msup → msup
    node.appendChild(groupNodes(baseNodes, doc));
    node.appendChild(convertGroup(scriptParent, doc));
    out.push(node);
    return;
  }

  // Over/under scripts (accents, hats, bars, limits). CHTML wraps each part in
  // <mjx-base>/<mjx-over>/<mjx-under> in *visual* (top-to-bottom) order; MathML
  // wants base first, then under, then over.
  if (tag === "mjx-mover" || tag === "mjx-munder" || tag === "mjx-munderover") {
    let base: Element | null = null;
    let over: Element | null = null;
    let under: Element | null = null;
    const loose: Node[] = [];
    for (const child of el.childNodes) {
      if (child.nodeType !== 1) continue;
      const childEl = child as Element;
      const childTag = childEl.tagName.toLowerCase();
      if (childTag === "mjx-base") base = childEl;
      else if (childTag === "mjx-over") over = childEl;
      else if (childTag === "mjx-under") under = childEl;
      else convertElement(childEl, doc, loose);
    }
    const node = doc.createElement(tag.slice(4));
    node.appendChild(base ? convertGroup(base, doc) : groupNodes(loose, doc));
    if (tag === "mjx-munder") {
      node.appendChild(convertGroup(under, doc));
    } else if (tag === "mjx-mover") {
      node.appendChild(convertGroup(over, doc));
    } else {
      node.appendChild(convertGroup(under, doc));
      node.appendChild(convertGroup(over, doc));
    }
    out.push(node);
    return;
  }

  // Fractions: numerator/denominator are reachable via <mjx-num>/<mjx-den>,
  // ignoring the intervening layout wrappers (<mjx-frac>/<mjx-dbox>/…).
  if (tag === "mjx-mfrac") {
    const num = el.querySelector("mjx-num");
    const den = el.querySelector("mjx-den");
    if (num && den) {
      const node = doc.createElement("mfrac");
      node.appendChild(convertGroup(num, doc));
      node.appendChild(convertGroup(den, doc));
      out.push(node);
      return;
    }
    convertChildren(el, doc, out);
    return;
  }

  // Square roots: the radicand lives in <mjx-box>, the radical glyph in <mjx-surd>.
  if (tag === "mjx-msqrt") {
    const box = el.querySelector("mjx-box");
    if (box) {
      const node = doc.createElement("msqrt");
      node.appendChild(convertGroup(box, doc));
      out.push(node);
      return;
    }
    convertChildren(el, doc, out);
    return;
  }

  // Unknown <mjx-*> wrapper: unwrap so its inner tokens still render.
  if (tag.startsWith("mjx-")) {
    convertChildren(el, doc, out);
    return;
  }

  // A stray non-MathJax element inside the math tree: drop it.
}

/**
 * Convert any MathJax CHTML (`<mjx-container>`) blocks in an HTML fragment into
 * presentation MathML. Returns the input unchanged when no CHTML is present (the
 * common case), so this is a cheap no-op for the vast majority of entries.
 */
export function convertMathJaxChtmlToMathml(html: string): string {
  if (!html.includes("mjx-container")) return html;

  const isFullDocument =
    html.trim().toLowerCase().startsWith("<!doctype") ||
    html.trim().toLowerCase().startsWith("<html");
  const htmlToParse = isFullDocument ? html : `<!DOCTYPE html><html><body>${html}</body></html>`;
  const { document } = parseHTML(htmlToParse);

  for (const container of document.querySelectorAll("mjx-container")) {
    const source = container.querySelector("mjx-math");
    const math = document.createElement("math");
    math.setAttribute("xmlns", MATHML_NS);
    // Block (display) vs inline math.
    const isDisplay =
      container.getAttribute("display") === "true" || source?.getAttribute("display") === "true";
    if (isDisplay) math.setAttribute("display", "block");
    if (source) {
      const nodes: Node[] = [];
      convertChildren(source, document, nodes);
      for (const node of nodes) math.appendChild(node);
    }
    container.replaceWith(math);
  }

  // MathJax ships a <style> block alongside the CHTML to position glyphs; with
  // the CHTML gone it is dead weight (and the sanitizer drops <style> anyway).
  for (const style of document.querySelectorAll("style")) style.remove();

  return isFullDocument ? document.toString() : document.body.innerHTML;
}
