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
 * sanitization. When the container carries MathJax's assistive MathML
 * (`<mjx-assistive-mml>`, produced by the AssistiveMmlHandler extension), that
 * exact MathML is used verbatim — it is the ground truth the CHTML was rendered
 * from. Otherwise the CHTML tree is reconstructed structurally, keyed off the
 * semantic `<mjx-*>` wrapper names MathJax emits (verified against real
 * mathjax-full 3.2.2 output — the version LessWrong uses); unrecognized
 * wrappers are unwrapped so their inner tokens still survive (lossy but
 * readable) rather than being dropped, and are logged so layout drift in a
 * future MathJax version is noticed rather than silently degrading.
 *
 * This runs inside `sanitizeEntryHtml`, so its output is covered by the same
 * persisted-sanitized-content cache; bump `SANITIZER_VERSION` when changing it.
 */

import { parseHTML } from "linkedom";

import { logger } from "@/lib/logger";

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

// MathJax token elements → MathML token elements. These hold the actual glyphs
// (as nested <mjx-c> / <mjx-utext>), so we flatten their characters into text
// content rather than recursing structurally.
const TOKEN_TAGS: Record<string, string> = {
  "mjx-mi": "mi",
  "mjx-mo": "mo",
  "mjx-mn": "mn",
  "mjx-ms": "ms",
  "mjx-mtext": "mtext",
};

// Layout-only wrappers whose children are unwrapped in place without logging.
// Everything else that starts with `mjx-` and isn't structurally handled gets
// unwrapped too, but is reported (see convertElement's fallback).
const KNOWN_LAYOUT_TAGS = new Set([
  "mjx-texatom",
  "mjx-mrow",
  "mjx-mstyle",
  "mjx-mpadded",
  "mjx-box",
  "mjx-row",
  "mjx-block",
  "mjx-spacer",
  "mjx-strut",
  "mjx-nstrut",
  "mjx-dstrut",
  "mjx-tstrut",
  "mjx-line",
  "mjx-mark",
]);

/** Per-conversion state threaded through the tree walk. */
interface ConvertContext {
  doc: Document;
  /** `mjx-*` tags that hit the unknown-wrapper fallback, for one log per call. */
  unknownTags: Set<string>;
}

/**
 * Extract the Unicode character a MathJax glyph element represents from its
 * `mjx-c<HEX>` class. Surrogate codepoints (U+D800–U+DFFF) are rejected —
 * `String.fromCodePoint` would happily produce a lone surrogate, letting a
 * hostile class name inject ill-formed UTF-16 into persisted content.
 */
function codepointChar(el: Element): string {
  const cls = el.getAttribute("class") ?? "";
  const match = cls.match(/\bmjx-c([0-9A-Fa-f]{2,6})\b/);
  if (!match) return "";
  const codepoint = parseInt(match[1], 16);
  if (codepoint >= 0xd800 && codepoint <= 0xdfff) return "";
  try {
    return String.fromCodePoint(codepoint);
  } catch {
    return "";
  }
}

/**
 * Collect the text of a token element in document order: `<mjx-c>` glyphs
 * decode from their class codepoint, `<mjx-utext>` (characters outside the
 * MathJax fonts, e.g. CJK) contribute their real text content. Stretchy
 * operators are special-cased: MathJax decomposes the glyph into assembly
 * pieces (`<mjx-stretchy-v/h>` → beg/ext/end with *classless* `<mjx-c>`
 * children) and puts the real codepoint class on the stretchy element itself,
 * so we read it from there.
 */
function tokenText(el: Element): string {
  let text = "";
  const walk = (node: Element): void => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      const childEl = child as Element;
      const tag = childEl.tagName.toLowerCase();
      if (tag === "mjx-c") {
        text += codepointChar(childEl);
      } else if (tag === "mjx-utext") {
        text += childEl.textContent ?? "";
      } else if (tag === "mjx-stretchy-v" || tag === "mjx-stretchy-h") {
        text += codepointChar(childEl);
      } else {
        walk(childEl);
      }
    }
  };
  walk(el);
  return text;
}

/** Convert every element child of `parent`, appending results to `out`. */
function convertChildren(parent: Element, ctx: ConvertContext, out: Node[]): void {
  for (const child of parent.childNodes) {
    if (child.nodeType === 1) convertElement(child as Element, ctx, out);
  }
}

/** Wrap a node list as a single MathML node (an <mrow> when there are 0 or >1). */
function groupNodes(nodes: Node[], ctx: ConvertContext): Node {
  if (nodes.length === 1) return nodes[0];
  const mrow = ctx.doc.createElement("mrow");
  for (const node of nodes) mrow.appendChild(node);
  return mrow;
}

/** Convert the children of `parent` and wrap them as a single MathML node. */
function convertGroup(parent: Element | null, ctx: ConvertContext): Node {
  const nodes: Node[] = [];
  if (parent) convertChildren(parent, ctx, nodes);
  return groupNodes(nodes, ctx);
}

/**
 * Locate the numerator/denominator wrappers belonging to a single `<mjx-mfrac>`,
 * descending through MathJax's layout wrappers but stopping at this fraction's
 * own `<mjx-num>`/`<mjx-den>` and at any nested `<mjx-mfrac>` (whose parts are
 * not ours). This avoids a descendant `querySelector` matching a nested
 * fraction's parts.
 */
function findFractionParts(frac: Element): {
  num: Element | null;
  den: Element | null;
} {
  let num: Element | null = null;
  let den: Element | null = null;
  const visit = (node: Element): void => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      const childEl = child as Element;
      const childTag = childEl.tagName.toLowerCase();
      if (childTag === "mjx-num") {
        num ??= childEl;
      } else if (childTag === "mjx-den") {
        den ??= childEl;
      } else if (childTag !== "mjx-mfrac") {
        visit(childEl);
      }
    }
  };
  visit(frac);
  return { num, den };
}

/**
 * Locate the `<mjx-base>` / `<mjx-over>` / `<mjx-under>` parts of an
 * over/under-script element. Inline accents keep them as direct children, but
 * display-mode large operators nest them in composition wrappers — e.g. a
 * display `munderover` is laid out as
 * `<mjx-munderover><mjx-over>…</mjx-over><mjx-box><mjx-munder><mjx-row><mjx-base>…`
 * — so we descend through the layout set {row, box, munder, mover, munderover}.
 * We never descend *into* a found part, so parts belonging to user content
 * nested inside the base/scripts are not confused with ours.
 */
function findScriptParts(el: Element): {
  base: Element | null;
  over: Element | null;
  under: Element | null;
} {
  let base: Element | null = null;
  let over: Element | null = null;
  let under: Element | null = null;
  const layout = new Set(["mjx-row", "mjx-box", "mjx-munder", "mjx-mover", "mjx-munderover"]);
  const visit = (node: Element): void => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      const childEl = child as Element;
      const childTag = childEl.tagName.toLowerCase();
      if (childTag === "mjx-base") {
        base ??= childEl;
      } else if (childTag === "mjx-over") {
        over ??= childEl;
      } else if (childTag === "mjx-under") {
        under ??= childEl;
      } else if (layout.has(childTag)) {
        visit(childEl);
      }
    }
  };
  visit(el);
  return { base, over, under };
}

/**
 * Split an `<mjx-script>`'s children into the groups separated by
 * `<mjx-spacer>`. MathJax stacks multi-script content visually (top first), so
 * for `msubsup` the groups are [sup, sub] and for script-layout `munderover`
 * they are [over, under].
 */
function splitScriptGroups(script: Element, ctx: ConvertContext): Node[][] {
  const groups: Node[][] = [[]];
  for (const child of script.childNodes) {
    if (child.nodeType !== 1) continue;
    const childEl = child as Element;
    if (childEl.tagName.toLowerCase() === "mjx-spacer") {
      groups.push([]);
    } else {
      convertElement(childEl, ctx, groups[groups.length - 1]);
    }
  }
  return groups;
}

/**
 * Partition a scripted element's children into base nodes and its
 * `<mjx-script>` child (msub/msup/msubsup and inline `munderover` all lay out
 * as [base…, <mjx-script>]).
 */
function partitionScript(
  el: Element,
  ctx: ConvertContext
): { baseNodes: Node[]; script: Element | null } {
  const baseNodes: Node[] = [];
  let script: Element | null = null;
  for (const child of el.childNodes) {
    if (child.nodeType !== 1) continue;
    const childEl = child as Element;
    if (childEl.tagName.toLowerCase() === "mjx-script") script = childEl;
    else convertElement(childEl, ctx, baseNodes);
  }
  return { baseNodes, script };
}

/**
 * Convert a table structure: `<mjx-mtable><mjx-table><mjx-itable><mjx-mtr>
 * <mjx-mtd>…` → `<mtable><mtr><mtd>…`, descending through the intermediate
 * layout wrappers to find rows, and cells within rows.
 */
function convertTable(el: Element, ctx: ConvertContext): Node {
  const mtable = ctx.doc.createElement("mtable");
  const visitRows = (node: Element): void => {
    for (const child of node.childNodes) {
      if (child.nodeType !== 1) continue;
      const childEl = child as Element;
      const childTag = childEl.tagName.toLowerCase();
      if (childTag === "mjx-mtr" || childTag === "mjx-mlabeledtr") {
        const mtr = ctx.doc.createElement("mtr");
        for (const cell of childEl.childNodes) {
          if (cell.nodeType !== 1) continue;
          const cellEl = cell as Element;
          if (cellEl.tagName.toLowerCase() === "mjx-mtd") {
            const mtd = ctx.doc.createElement("mtd");
            mtd.appendChild(convertGroup(cellEl, ctx));
            mtr.appendChild(mtd);
          }
        }
        mtable.appendChild(mtr);
      } else if (childTag === "mjx-mtable" || TOKEN_TAGS[childTag]) {
        // A nested table or content element belongs to a cell, not to us —
        // only descend through this table's own layout wrappers.
      } else {
        visitRows(childEl);
      }
    }
  };
  visitRows(el);
  return mtable;
}

function convertElement(el: Element, ctx: ConvertContext, out: Node[]): void {
  const tag = el.tagName.toLowerCase();
  const doc = ctx.doc;

  if (tag === "mjx-c") {
    out.push(doc.createTextNode(codepointChar(el)));
    return;
  }

  // Characters outside the MathJax fonts (CJK, etc.) carry real text.
  if (tag === "mjx-utext") {
    out.push(doc.createTextNode(el.textContent ?? ""));
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
    out.push(convertGroup(el, ctx));
    return;
  }

  // Explicit spacing (\quad, \, …): the width lives in the inline style.
  if (tag === "mjx-mspace") {
    const width = (el.getAttribute("style") ?? "").match(/width:\s*([^;]+)/)?.[1]?.trim();
    const node = doc.createElement("mspace");
    if (width) node.setAttribute("width", width);
    out.push(node);
    return;
  }

  // Sub/superscripts: CHTML lays out [base …, <mjx-script>script</mjx-script>];
  // msubsup's script stacks sup then sub, separated by <mjx-spacer>.
  if (tag === "mjx-msup" || tag === "mjx-msub" || tag === "mjx-msubsup") {
    const { baseNodes, script } = partitionScript(el, ctx);
    const groups = script ? splitScriptGroups(script, ctx) : [];
    if (tag === "mjx-msubsup" && groups.length >= 2) {
      const node = doc.createElement("msubsup");
      node.appendChild(groupNodes(baseNodes, ctx));
      node.appendChild(groupNodes(groups[1], ctx)); // sub (stacked below)
      node.appendChild(groupNodes(groups[0], ctx)); // sup (stacked above)
      out.push(node);
      return;
    }
    const node = doc.createElement(tag === "mjx-msubsup" ? "msubsup" : tag.slice(4));
    node.appendChild(groupNodes(baseNodes, ctx));
    for (const group of groups) node.appendChild(groupNodes(group, ctx));
    out.push(node);
    return;
  }

  // Over/under scripts (accents, display-mode operator limits). Two layouts:
  // named part wrappers (possibly nested in composition wrappers — see
  // findScriptParts), or, for inline operators with limits="false", the same
  // [base, <mjx-script>] layout as msubsup with over stacked above under.
  if (tag === "mjx-mover" || tag === "mjx-munder" || tag === "mjx-munderover") {
    const { base, over, under } = findScriptParts(el);
    if (!base && !over && !under) {
      const { baseNodes, script } = partitionScript(el, ctx);
      const groups = script ? splitScriptGroups(script, ctx) : [];
      if (tag === "mjx-munderover" && groups.length >= 2) {
        const node = doc.createElement("munderover");
        node.appendChild(groupNodes(baseNodes, ctx));
        node.appendChild(groupNodes(groups[1], ctx)); // under (stacked below)
        node.appendChild(groupNodes(groups[0], ctx)); // over (stacked above)
        out.push(node);
        return;
      }
      const node = doc.createElement(tag.slice(4));
      node.appendChild(groupNodes(baseNodes, ctx));
      for (const group of groups) node.appendChild(groupNodes(group, ctx));
      out.push(node);
      return;
    }
    const node = doc.createElement(tag.slice(4));
    node.appendChild(convertGroup(base, ctx));
    if (tag === "mjx-munder") {
      node.appendChild(convertGroup(under, ctx));
    } else if (tag === "mjx-mover") {
      node.appendChild(convertGroup(over, ctx));
    } else {
      node.appendChild(convertGroup(under, ctx));
      node.appendChild(convertGroup(over, ctx));
    }
    out.push(node);
    return;
  }

  // Fractions: numerator/denominator are reachable via <mjx-num>/<mjx-den>,
  // ignoring the intervening layout wrappers (<mjx-frac>/<mjx-dbox>/…). A plain
  // `querySelector` would descend into a *nested* fraction and grab its
  // <mjx-den> (which precedes this fraction's own <mjx-den> in document order,
  // since nested fractions live inside <mjx-num>), so we use a scoped search
  // that stops at this fraction's parts and at any nested <mjx-mfrac>.
  if (tag === "mjx-mfrac") {
    const { num, den } = findFractionParts(el);
    if (num && den) {
      const node = doc.createElement("mfrac");
      node.appendChild(convertGroup(num, ctx));
      node.appendChild(convertGroup(den, ctx));
      out.push(node);
      return;
    }
    convertChildren(el, ctx, out);
    return;
  }

  // Square roots: the radicand lives in <mjx-box>, the radical glyph in
  // <mjx-surd>. Safe against nesting: the outer <mjx-box> is an ancestor of
  // any inner one, so it wins document order.
  if (tag === "mjx-msqrt" || tag === "mjx-sqrt") {
    const box = el.querySelector("mjx-box");
    if (box) {
      const node = doc.createElement("msqrt");
      node.appendChild(convertGroup(box, ctx));
      out.push(node);
      return;
    }
    convertChildren(el, ctx, out);
    return;
  }

  // Roots with an index: <mjx-mroot><mjx-root>index</mjx-root><mjx-sqrt>
  // <mjx-surd>√</mjx-surd><mjx-box>radicand</mjx-box></mjx-sqrt></mjx-mroot>.
  // MathML order is (base, index).
  if (tag === "mjx-mroot") {
    const index = el.querySelector("mjx-root");
    const box = el.querySelector("mjx-box");
    if (index && box) {
      const node = doc.createElement("mroot");
      node.appendChild(convertGroup(box, ctx));
      node.appendChild(convertGroup(index, ctx));
      out.push(node);
      return;
    }
    convertChildren(el, ctx, out);
    return;
  }

  // Tables (matrices, cases, aligned environments).
  if (tag === "mjx-mtable") {
    out.push(convertTable(el, ctx));
    return;
  }

  // The radical glyph is drawn by MathML itself; drop the CHTML one.
  if (tag === "mjx-surd") {
    return;
  }

  // Known layout-only wrappers: unwrap silently.
  if (KNOWN_LAYOUT_TAGS.has(tag)) {
    convertChildren(el, ctx, out);
    return;
  }

  // Unknown <mjx-*> wrapper: unwrap so its inner tokens still render, and
  // record it — this is the canary for MathJax layout drift.
  if (tag.startsWith("mjx-")) {
    ctx.unknownTags.add(tag);
    convertChildren(el, ctx, out);
    return;
  }

  // A stray non-MathJax element inside the math tree: drop it.
}

/**
 * Convert any MathJax CHTML (`<mjx-container>`) blocks in an HTML string into
 * presentation MathML. Returns the input unchanged when no CHTML is present
 * (the common case), so this is a cheap no-op for the vast majority of entries.
 *
 * linkedom's parse/serialize round-trips both fragments and full documents
 * faithfully (including content after a stray `</body>`, which a synthetic
 * body wrapper would truncate), so the input is parsed as-is.
 */
export function convertMathJaxChtmlToMathml(html: string): string {
  if (!html.includes("<mjx-container")) return html;

  const { document } = parseHTML(html);
  const containers = document.querySelectorAll("mjx-container");
  // Guard false-positive (the substring appeared in text/attribute/comment):
  // return the original string untouched rather than reserializing.
  if (containers.length === 0) return html;

  const ctx: ConvertContext = { doc: document, unknownTags: new Set() };

  for (const container of containers) {
    // Prefer MathJax's own assistive MathML when present — it is the exact
    // MathML the CHTML was rendered from, strictly better than reconstruction.
    const assistive = container.querySelector("mjx-assistive-mml > math");
    if (assistive) {
      if (!assistive.getAttribute("xmlns")) assistive.setAttribute("xmlns", MATHML_NS);
      container.replaceWith(assistive);
      continue;
    }

    const source = container.querySelector("mjx-math");
    if (!source) {
      // Nothing to convert; remove the container rather than leaving an empty
      // shell for the sanitizer to strip.
      container.remove();
      continue;
    }

    const math = document.createElement("math");
    math.setAttribute("xmlns", MATHML_NS);
    // Block (display) vs inline math.
    const isDisplay =
      container.getAttribute("display") === "true" || source.getAttribute("display") === "true";
    if (isDisplay) math.setAttribute("display", "block");
    const nodes: Node[] = [];
    convertChildren(source, ctx, nodes);
    for (const node of nodes) math.appendChild(node);
    container.replaceWith(math);
  }

  if (ctx.unknownTags.size > 0) {
    logger.warn("Unwrapped unrecognized MathJax CHTML wrappers during MathML conversion", {
      tags: [...ctx.unknownTags].sort(),
    });
  }

  return document.toString();
}
