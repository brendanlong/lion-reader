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
 * ## Why this doesn't parse the whole document
 *
 * The structural work is localized to individual `<mjx-container>` blocks, which
 * are typically a small fraction of a (possibly large) article. Rather than
 * building a DOM for the entire body (the previous linkedom approach parsed and
 * re-serialized everything — the dominant cost on math-heavy content, see
 * issue #1054), we make a single streaming `htmlparser2` pass over the input:
 * text outside the containers is spliced through **verbatim** (tracked by byte
 * offset), and while inside a container the parser's SAX events are forwarded
 * into a per-container `domhandler` `DomHandler` so a DOM is built *only* for
 * the equation subtree we actually rewrite. The structural reconstruction
 * (fraction/script/root/table reordering, scoped part lookups) genuinely needs
 * random access to that subtree, so it runs against the small DOM; the rest of
 * the document is never tokenized into nodes. Forwarding events into an existing
 * handler (instead of re-`parseDocument`-ing each container substring) means the
 * container bytes are tokenized once, not twice. Everything outside the
 * containers is byte-identical to the input, which also makes the no-op /
 * false-positive paths exact.
 *
 * This runs inside `sanitizeEntryHtml`, so its output is covered by the same
 * persisted-sanitized-content cache; bump `SANITIZER_VERSION` when changing it.
 */

import { render } from "dom-serializer";
import { type ChildNode, type Document, DomHandler, Element, isTag, Text } from "domhandler";
import { findOne, textContent } from "domutils";
import { Parser } from "htmlparser2";

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
  /** `mjx-*` tags that hit the unknown-wrapper fallback, for one log per call. */
  unknownTags: Set<string>;
}

// htmlparser2 lowercases tag names by default (non-XML mode), so every `.name`
// we compare against below is already lowercase — no per-node toLowerCase().

/** Build a MathML element node with the given children (parent links set). */
function makeElement(
  name: string,
  children: ChildNode[] = [],
  attribs: Record<string, string> = {}
): Element {
  const el = new Element(name, attribs, children);
  for (const child of children) child.parent = el;
  return el;
}

/**
 * Extract the Unicode character a MathJax glyph element represents from its
 * `mjx-c<HEX>` class. Surrogate codepoints (U+D800–U+DFFF) are rejected —
 * `String.fromCodePoint` would happily produce a lone surrogate, letting a
 * hostile class name inject ill-formed UTF-16 into persisted content.
 */
function codepointChar(el: Element): string {
  const cls = el.attribs.class ?? "";
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
    for (const child of node.children) {
      if (!isTag(child)) continue;
      const tag = child.name;
      if (tag === "mjx-c") {
        text += codepointChar(child);
      } else if (tag === "mjx-utext") {
        text += textContent(child);
      } else if (tag === "mjx-stretchy-v" || tag === "mjx-stretchy-h") {
        text += codepointChar(child);
      } else {
        walk(child);
      }
    }
  };
  walk(el);
  return text;
}

/** Convert every element child of `parent`, appending results to `out`. */
function convertChildren(parent: Element, ctx: ConvertContext, out: ChildNode[]): void {
  for (const child of parent.children) {
    if (isTag(child)) convertElement(child, ctx, out);
  }
}

/** Wrap a node list as a single MathML node (an <mrow> when there are 0 or >1). */
function groupNodes(nodes: ChildNode[]): ChildNode {
  if (nodes.length === 1) return nodes[0];
  return makeElement("mrow", nodes);
}

/** Convert the children of `parent` and wrap them as a single MathML node. */
function convertGroup(parent: Element | null, ctx: ConvertContext): ChildNode {
  const nodes: ChildNode[] = [];
  if (parent) convertChildren(parent, ctx, nodes);
  return groupNodes(nodes);
}

/** First descendant element (any depth) with the given tag name, or null. */
function firstDescendant(el: Element, name: string): Element | null {
  return findOne((candidate) => candidate.name === name, el.children, true);
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
    for (const child of node.children) {
      if (!isTag(child)) continue;
      const childTag = child.name;
      if (childTag === "mjx-num") {
        num ??= child;
      } else if (childTag === "mjx-den") {
        den ??= child;
      } else if (childTag !== "mjx-mfrac") {
        visit(child);
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
    for (const child of node.children) {
      if (!isTag(child)) continue;
      const childTag = child.name;
      if (childTag === "mjx-base") {
        base ??= child;
      } else if (childTag === "mjx-over") {
        over ??= child;
      } else if (childTag === "mjx-under") {
        under ??= child;
      } else if (layout.has(childTag)) {
        visit(child);
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
function splitScriptGroups(script: Element, ctx: ConvertContext): ChildNode[][] {
  const groups: ChildNode[][] = [[]];
  for (const child of script.children) {
    if (!isTag(child)) continue;
    if (child.name === "mjx-spacer") {
      groups.push([]);
    } else {
      convertElement(child, ctx, groups[groups.length - 1]);
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
): { baseNodes: ChildNode[]; script: Element | null } {
  const baseNodes: ChildNode[] = [];
  let script: Element | null = null;
  for (const child of el.children) {
    if (!isTag(child)) continue;
    if (child.name === "mjx-script") script = child;
    else convertElement(child, ctx, baseNodes);
  }
  return { baseNodes, script };
}

/**
 * Convert a table structure: `<mjx-mtable><mjx-table><mjx-itable><mjx-mtr>
 * <mjx-mtd>…` → `<mtable><mtr><mtd>…`, descending through the intermediate
 * layout wrappers to find rows, and cells within rows.
 */
function convertTable(el: Element, ctx: ConvertContext): ChildNode {
  const rows: ChildNode[] = [];
  const visitRows = (node: Element): void => {
    for (const child of node.children) {
      if (!isTag(child)) continue;
      const childTag = child.name;
      if (childTag === "mjx-mtr" || childTag === "mjx-mlabeledtr") {
        const cells: ChildNode[] = [];
        for (const cell of child.children) {
          if (!isTag(cell)) continue;
          if (cell.name === "mjx-mtd") {
            cells.push(makeElement("mtd", [convertGroup(cell, ctx)]));
          }
        }
        rows.push(makeElement("mtr", cells));
      } else if (childTag === "mjx-mtable" || TOKEN_TAGS[childTag]) {
        // A nested table or content element belongs to a cell, not to us —
        // only descend through this table's own layout wrappers.
      } else {
        visitRows(child);
      }
    }
  };
  visitRows(el);
  return makeElement("mtable", rows);
}

function convertElement(el: Element, ctx: ConvertContext, out: ChildNode[]): void {
  const tag = el.name;

  if (tag === "mjx-c") {
    out.push(new Text(codepointChar(el)));
    return;
  }

  // Characters outside the MathJax fonts (CJK, etc.) carry real text.
  if (tag === "mjx-utext") {
    out.push(new Text(textContent(el)));
    return;
  }

  const tokenTag = TOKEN_TAGS[tag];
  if (tokenTag) {
    out.push(makeElement(tokenTag, [new Text(tokenText(el))]));
    return;
  }

  // texatom and mrow are plain horizontal groupings.
  if (tag === "mjx-texatom" || tag === "mjx-mrow") {
    out.push(convertGroup(el, ctx));
    return;
  }

  // Explicit spacing (\quad, \, …): the width lives in the inline style.
  if (tag === "mjx-mspace") {
    const width = (el.attribs.style ?? "").match(/width:\s*([^;]+)/)?.[1]?.trim();
    out.push(makeElement("mspace", [], width ? { width } : {}));
    return;
  }

  // Sub/superscripts: CHTML lays out [base …, <mjx-script>script</mjx-script>];
  // msubsup's script stacks sup then sub, separated by <mjx-spacer>.
  if (tag === "mjx-msup" || tag === "mjx-msub" || tag === "mjx-msubsup") {
    const { baseNodes, script } = partitionScript(el, ctx);
    const groups = script ? splitScriptGroups(script, ctx) : [];
    if (tag === "mjx-msubsup" && groups.length >= 2) {
      out.push(
        makeElement("msubsup", [
          groupNodes(baseNodes),
          groupNodes(groups[1]), // sub (stacked below)
          groupNodes(groups[0]), // sup (stacked above)
        ])
      );
      return;
    }
    const name = tag === "mjx-msubsup" ? "msubsup" : tag.slice(4);
    out.push(makeElement(name, [groupNodes(baseNodes), ...groups.map(groupNodes)]));
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
        out.push(
          makeElement("munderover", [
            groupNodes(baseNodes),
            groupNodes(groups[1]), // under (stacked below)
            groupNodes(groups[0]), // over (stacked above)
          ])
        );
        return;
      }
      out.push(makeElement(tag.slice(4), [groupNodes(baseNodes), ...groups.map(groupNodes)]));
      return;
    }
    const children: ChildNode[] = [convertGroup(base, ctx)];
    if (tag === "mjx-munder") {
      children.push(convertGroup(under, ctx));
    } else if (tag === "mjx-mover") {
      children.push(convertGroup(over, ctx));
    } else {
      children.push(convertGroup(under, ctx));
      children.push(convertGroup(over, ctx));
    }
    out.push(makeElement(tag.slice(4), children));
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
      out.push(makeElement("mfrac", [convertGroup(num, ctx), convertGroup(den, ctx)]));
      return;
    }
    convertChildren(el, ctx, out);
    return;
  }

  // Square roots: the radicand lives in <mjx-box>, the radical glyph in
  // <mjx-surd>. Safe against nesting: the outer <mjx-box> is an ancestor of
  // any inner one, so it wins document order.
  if (tag === "mjx-msqrt" || tag === "mjx-sqrt") {
    const box = firstDescendant(el, "mjx-box");
    if (box) {
      out.push(makeElement("msqrt", [convertGroup(box, ctx)]));
      return;
    }
    convertChildren(el, ctx, out);
    return;
  }

  // Roots with an index: <mjx-mroot><mjx-root>index</mjx-root><mjx-sqrt>
  // <mjx-surd>√</mjx-surd><mjx-box>radicand</mjx-box></mjx-sqrt></mjx-mroot>.
  // MathML order is (base, index).
  if (tag === "mjx-mroot") {
    const index = firstDescendant(el, "mjx-root");
    const box = firstDescendant(el, "mjx-box");
    if (index && box) {
      out.push(makeElement("mroot", [convertGroup(box, ctx), convertGroup(index, ctx)]));
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

/** The `<math>` inside a container's `<mjx-assistive-mml>`, if present. */
function findAssistiveMath(container: Element): Element | null {
  const assistive = firstDescendant(container, "mjx-assistive-mml");
  if (!assistive) return null;
  for (const child of assistive.children) {
    if (isTag(child) && child.name === "math") return child;
  }
  return null;
}

/** First element (tag) child of a node, or null. */
function firstElementChild(parent: Element | Document): Element | null {
  for (const child of parent.children) {
    if (isTag(child)) return child;
  }
  return null;
}

/**
 * Convert one parsed `<mjx-container>` element to a MathML string. Returns "" when
 * the container carries no math (so the caller drops it).
 */
function convertContainerElement(container: Element, ctx: ConvertContext): string {
  // Prefer MathJax's own assistive MathML when present — it is the exact MathML
  // the CHTML was rendered from, strictly better than reconstruction.
  const assistive = findAssistiveMath(container);
  if (assistive) {
    if (!assistive.attribs.xmlns) assistive.attribs.xmlns = MATHML_NS;
    return render(assistive);
  }

  const source = firstDescendant(container, "mjx-math");
  // Nothing to convert; drop the container rather than leaving an empty shell.
  if (!source) return "";

  const nodes: ChildNode[] = [];
  convertChildren(source, ctx, nodes);
  // Block (display) vs inline math.
  const isDisplay = container.attribs.display === "true" || source.attribs.display === "true";
  // Serialize the children (not a wrapping <math>) so dom-serializer stays in
  // HTML mode: `encodeEntities: "utf8"` then escapes only `< > & "` and leaves
  // the mathematical-alphanumeric codepoints (e.g. U+1D465 `𝑥`) as raw
  // characters. Rendering a `<math>` node instead flips dom-serializer into
  // "foreign" (XML) mode, which would emit those as numeric character
  // references — equivalent after sanitization, but needlessly unreadable.
  // The <math> wrapper is built here from fixed, trusted attribute values.
  const open = isDisplay
    ? `<math xmlns="${MATHML_NS}" display="block">`
    : `<math xmlns="${MATHML_NS}">`;
  return `${open}${render(nodes, { encodeEntities: "utf8" })}</math>`;
}

/**
 * Convert any MathJax CHTML (`<mjx-container>`) blocks in an HTML string into
 * presentation MathML. Returns the input unchanged when no CHTML is present
 * (the common case), so this is a cheap no-op for the vast majority of entries.
 *
 * Runs a single streaming `htmlparser2` pass: HTML outside the containers is
 * spliced through verbatim (byte-identical to the input, including content after
 * a stray `</body>`), while each container's SAX events are forwarded into a
 * `DomHandler` so only that equation subtree becomes a DOM — which the tree-walk
 * then rewrites. Depth-tracking on `<mjx-container>` guards the (unexpected)
 * nested container and a stray closing tag with no open.
 */
export function convertMathJaxChtmlToMathml(html: string): string {
  if (!html.includes("<mjx-container")) return html;

  const ctx: ConvertContext = { unknownTags: new Set() };
  let result = "";
  // Position up to which `html` has been copied into `result` verbatim.
  let cursor = 0;
  // Byte offset of the current top-level container's opening `<`.
  let containerStart = -1;
  // Nesting depth of `<mjx-container>` (0 = outside any container).
  let depth = 0;
  // The DOM builder for the container currently being read, else null.
  let handler: DomHandler | null = null;
  let converted = false;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === "mjx-container" && depth === 0) {
          // Enter a top-level container: start a fresh DOM for its subtree and
          // forward this opening tag into it.
          containerStart = parser.startIndex;
          depth = 1;
          handler = new DomHandler();
          handler.onopentag(name, attribs);
          return;
        }
        if (handler) {
          if (name === "mjx-container") depth++;
          handler.onopentag(name, attribs);
        }
      },
      ontext(text) {
        if (handler) handler.ontext(text);
      },
      onclosetag(name) {
        const active = handler;
        if (!active) return;
        // domhandler's onclosetag takes no name — it just pops its own stack.
        active.onclosetag();
        if (name !== "mjx-container") return;
        depth--;
        if (depth > 0) return;
        // Left the top-level container: finalize its DOM and rewrite it.
        active.onend();
        handler = null;
        const container = firstElementChild(active.root);
        result += html.slice(cursor, containerStart);
        // A container that somehow parsed to nothing is dropped (splice skips it).
        if (container) result += convertContainerElement(container, ctx);
        cursor = parser.endIndex + 1;
        converted = true;
      },
    },
    { decodeEntities: true }
  );
  parser.write(html);
  parser.end();

  // No real container was found (the substring appeared only in
  // text/attribute/comment): return the original string untouched.
  if (!converted) return html;

  result += html.slice(cursor);

  if (ctx.unknownTags.size > 0) {
    logger.warn("Unwrapped unrecognized MathJax CHTML wrappers during MathML conversion", {
      tags: [...ctx.unknownTags].sort(),
    });
  }

  return result;
}
