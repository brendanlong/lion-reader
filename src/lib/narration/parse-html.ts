/**
 * Parsing entry HTML server-side into the tree a browser would build.
 *
 * Narration numbers elements on both sides of the wire — the server to say
 * which paragraph is which, the client to stamp the `data-para-id`s those
 * numbers name — so the two must agree on the tree, not just on the numbering
 * rule (see `./block-elements`). The client gets its tree from `DOMParser`,
 * a spec tree builder. linkedom is not one: it leaves content where the markup
 * put it, where the spec's tree construction moves things. Content a table
 * can't hold is foster-parented out to just before the table, a `<table>`
 * closes an open `<p>`, an `<a>` inside an `<a>` closes the outer one — and the
 * sanitizer can't normalize any of it away first, being a streaming rewriter
 * that never builds a tree.
 *
 * So the server runs the markup through parse5 (the spec tree builder jsdom
 * uses) and hands linkedom the serialized result. Serializing a spec-built tree
 * leaves nothing for a lenient parser to get wrong — every implied end tag is
 * explicit and every moved node is already where a browser would put it — so
 * linkedom reproduces the browser's tree, and the walk stays the shared,
 * isomorphic code it is.
 *
 * Two things it does not fix, both handled elsewhere:
 *
 * - **Rawtext elements linkedom doesn't know are rawtext** (`iframe`). parse5
 *   reads their content as text, correctly, but serializing writes it back as
 *   markup and linkedom re-parses it into elements. `NON_PROSE` in
 *   `./block-elements` keeps the walk out of them on both sides instead.
 * - **Cost.** The second parse adds roughly half again to the parse, tens of ms
 *   on a large body. Narration is pure JS, so unlike the sanitizer and the
 *   article extractor it can't move that off the event loop (see "Event-loop
 *   protection" in `src/server/html/CLAUDE.md`); a big entry blocks it for as
 *   long as the walk itself already does.
 *
 * Server-only: both parsers are. Do not import this from a client component.
 *
 * @module narration/parse-html
 */

import { parseHTML } from "linkedom";
import { defaultTreeAdapter, parse, serialize, type DefaultTreeAdapterMap } from "parse5";

type Parse5Node = DefaultTreeAdapterMap["node"];

/**
 * Deepest element the normalizing parse builds, counting `<html>` as 1. Blink
 * flattens its tree beyond the same depth, and nothing real comes near it.
 *
 * @testonly
 */
export const MAX_TREE_DEPTH = 512;

/**
 * Parses entry HTML into a `<body>` element holding the tree a browser builds
 * from the same string.
 *
 * Markup past the point where the tree would nest deeper than
 * {@link MAX_TREE_DEPTH} is left out (#2039): parse5 searches its open
 * elements for many tags, and the sanitizer keeps feed-controlled nesting, so
 * an entry nested tens of thousands deep took about a minute to parse. Where
 * the browser's tree differs past that point (a foster-parented element moves
 * before a table), numbering can differ from there on.
 *
 * @param html - The (already sanitized) entry HTML
 * @returns The body element of the parsed document
 */
export function parseBodyAsBrowser(html: string): Element {
  // Wrapped in a document so the content parses in "in body" insertion mode —
  // the mode the client's `DOMParser` call uses for the same string.
  return parseHTML(serialize(parseDepthCapped(`<!DOCTYPE html><html><body>${html}</body></html>`)))
    .document.body;
}

/** Where to cut the markup so the tree stays within {@link MAX_TREE_DEPTH}. */
class TooDeep extends Error {
  constructor(readonly offset: number) {
    super("Markup nests too deep");
  }
}

/**
 * parse5's tree of the longest prefix of `markup` that stays within
 * {@link MAX_TREE_DEPTH}, cut at a start tag.
 *
 * The depth is measured on the tree parse5 builds, not on the markup: a
 * browser ignores `</span>` across an open `<div>`, so `<span><div></span>`
 * nests two levels per repeat while closing every element it opens, and
 * `<p><b>` closes the `<b>` a SAX count would leave open. The over-deep
 * element's start tag (or, for an implied element, the last one the parse
 * placed) is where the cut goes. Everything before it parsed without reaching
 * the limit, so the second parse of the prefix stays within it.
 */
function parseDepthCapped(markup: string): DefaultTreeAdapterMap["document"] {
  for (;;) {
    try {
      return parse(markup, {
        // `scriptingEnabled: false` matches `DOMParser`, whose documents have
        // scripting disabled (it decides how `<noscript>` content is parsed).
        scriptingEnabled: false,
        sourceCodeLocationInfo: true,
        treeAdapter: boundedTreeAdapter(),
      });
    } catch (error) {
      if (!(error instanceof TooDeep)) throw error;
      markup = markup.slice(0, error.offset);
    }
  }
}

/**
 * parse5's default tree, built within {@link MAX_TREE_DEPTH} (throwing
 * {@link TooDeep}). The parse also inserts and detaches at a table's position
 * (foster parenting, the adoption agency), which is at or near the end of its
 * parent's children; the default adapter finds it searching from the start,
 * which took seconds on a megabyte of `<table><div>`, so this searches from
 * the end.
 */
function boundedTreeAdapter(): typeof defaultTreeAdapter {
  // A template's content is a fragment with no parent; nesting goes on there.
  const templateHosts = new WeakMap<Parse5Node, Parse5Node>();
  let lastPlaced = 0;

  const check = (parent: Parse5Node, node: Parse5Node) => {
    if (!defaultTreeAdapter.isElementNode(node)) return;
    const start = node.sourceCodeLocation?.startOffset;
    if (start !== undefined) lastPlaced = start;
    let depth = 0;
    for (let n: Parse5Node | null | undefined = parent; n;) {
      if (++depth > MAX_TREE_DEPTH) throw new TooDeep(start ?? lastPlaced);
      n = ("parentNode" in n ? n.parentNode : null) ?? templateHosts.get(n);
    }
  };

  return {
    ...defaultTreeAdapter,
    appendChild(parent, node) {
      check(parent, node);
      defaultTreeAdapter.appendChild(parent, node);
    },
    insertBefore(parent, node, reference) {
      check(parent, node);
      parent.childNodes.splice(parent.childNodes.lastIndexOf(reference), 0, node);
      node.parentNode = parent;
    },
    insertTextBefore(parent, text, reference) {
      const previous = parent.childNodes[parent.childNodes.lastIndexOf(reference) - 1];
      if (previous && defaultTreeAdapter.isTextNode(previous)) previous.value += text;
      else this.insertBefore(parent, defaultTreeAdapter.createTextNode(text), reference);
    },
    detachNode(node) {
      if (!node.parentNode) return;
      const siblings = node.parentNode.childNodes;
      siblings.splice(siblings.lastIndexOf(node), 1);
      node.parentNode = null;
    },
    setTemplateContent(template, content) {
      templateHosts.set(content, template);
      defaultTreeAdapter.setTemplateContent(template, content);
    },
  };
}
