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
import {
  defaultTreeAdapter,
  Parser,
  serialize,
  type DefaultTreeAdapterMap,
  type Token,
} from "parse5";

type Parse5Node = DefaultTreeAdapterMap["node"];
type Parse5ParentNode = DefaultTreeAdapterMap["parentNode"];

/**
 * Deepest element the normalizing parse builds, counting `<html>` as 1. Blink
 * flattens its tree beyond the same depth, and nothing real comes near it.
 *
 * @testonly
 */
export const MAX_TREE_DEPTH = 512;

/**
 * The parse builds at most this many elements per tag token that builds any,
 * or per character of markup, whichever allows more, plus
 * {@link EXTRA_ELEMENT_ALLOWANCE}. Beyond its own element, a token can imply
 * some (`<tbody>`, or the `<p>` of a stray `</p>`), and text in a new
 * paragraph re-creates each formatting element left open before it, up to
 * three copies of each. Real markup stays well within either: an unclosed
 * `<b>` per paragraph builds about 2.5 per token, and a few unclosed tags
 * before a long run of plain paragraphs about one per 5 characters. Re-creation
 * is otherwise unbounded: hundreds of distinct unclosed tags reopen in every
 * paragraph.
 *
 * Each re-created element copies its attributes, so those are budgeted too:
 * `attributeCharsPerChar` characters of them per character of markup, enough
 * for an unclosed `<font face="…">` in every paragraph.
 *
 * @testonly
 */
export const MAX_ELEMENTS = { perToken: 3, perChar: 0.5, attributeCharsPerChar: 4 };

/** @testonly */
export const EXTRA_ELEMENT_ALLOWANCE = 1000;

/**
 * Parses entry HTML into a `<body>` element holding the tree a browser builds
 * from the same string.
 *
 * The parse stops at the first token after the tree nests deeper than
 * {@link MAX_TREE_DEPTH} or holds more than {@link MAX_ELEMENTS} allows
 * (#2039): parse5 searches its open elements for many tags, and the sanitizer
 * keeps feed-controlled markup, so a deeply nested entry took up to a minute
 * to parse. Where the browser's tree differs past the stop (a foster-parented
 * element moves before a table), numbering can differ from there on.
 *
 * @param html - The (already sanitized) entry HTML
 * @returns The body element of the parsed document
 */
export function parseBodyAsBrowser(html: string): Element {
  // Wrapped in a document so the content parses in "in body" insertion mode —
  // the mode the client's `DOMParser` call uses for the same string.
  return parseHTML(serialize(parseBounded(`<!DOCTYPE html><html><body>${html}</body></html>`)))
    .document.body;
}

class TreeTooBig extends Error {
  constructor() {
    super("Markup builds too big a tree");
  }
}

/**
 * parse5's tree of `markup`, up to the first token after it went past
 * {@link MAX_TREE_DEPTH} or {@link MAX_ELEMENTS}.
 *
 * Both are measured on the tree parse5 builds, not on the markup: a browser
 * ignores `</span>` across an open `<div>`, so `<span><div></span>` nests two
 * levels per repeat while closing every element it opens, and `<p><b>` closes
 * the `<b>` a SAX count would leave open. The parse stops between tokens, never
 * inside one, because one token's tree changes (the adoption agency's moves)
 * leave content detached until they finish. One token's work stays within
 * bounds anyway: it re-creates no more than is already open.
 */
function parseBounded(markup: string): DefaultTreeAdapterMap["document"] {
  const parser = new BoundedParser(new TreeBounds(markup.length));
  try {
    parser.tokenizer.write(markup, true);
  } catch (error) {
    if (!(error instanceof TreeTooBig)) throw error;
  }
  return parser.document;
}

/** What the parse has built so far, against what it may build. */
class TreeBounds {
  exceeded = false;
  /** Incremented by the parser at each tag token. */
  tagToken = 0;
  private lastCountedToken = -1;
  private buildingTokens = 0;
  private elements = 0;
  private attributeChars = 0;
  private readonly maxElementsByLength: number;
  private readonly maxAttributeChars: number;
  // A template's content is a fragment with no parent; nesting goes on there.
  private readonly templateHosts = new WeakMap<Parse5Node, Parse5Node>();

  constructor(markupLength: number) {
    this.maxElementsByLength = markupLength * MAX_ELEMENTS.perChar + EXTRA_ELEMENT_ALLOWANCE;
    this.maxAttributeChars = markupLength * MAX_ELEMENTS.attributeCharsPerChar;
  }

  created(attrs: readonly { name: string; value: string }[]): void {
    this.elements++;
    for (const { name, value } of attrs) this.attributeChars += name.length + value.length;
  }

  placed(parent: Parse5Node, node: Parse5Node): void {
    if (this.exceeded || !defaultTreeAdapter.isElementNode(node)) return;
    if (this.tagToken !== this.lastCountedToken) {
      this.lastCountedToken = this.tagToken;
      this.buildingTokens++;
    }
    const maxElements = Math.max(
      this.buildingTokens * MAX_ELEMENTS.perToken + EXTRA_ELEMENT_ALLOWANCE,
      this.maxElementsByLength
    );
    let depth = 0;
    for (let n: Parse5Node | null | undefined = parent; n && depth <= MAX_TREE_DEPTH; depth++) {
      n = ("parentNode" in n ? n.parentNode : null) ?? this.templateHosts.get(n);
    }
    this.exceeded =
      depth > MAX_TREE_DEPTH ||
      this.elements > maxElements ||
      this.attributeChars > this.maxAttributeChars;
  }

  setTemplateHost(content: Parse5Node, template: Parse5Node): void {
    this.templateHosts.set(content, template);
  }
}

class BoundedParser extends Parser<DefaultTreeAdapterMap> {
  constructor(private readonly bounds: TreeBounds) {
    super({
      // `scriptingEnabled: false` matches `DOMParser`, whose documents have
      // scripting disabled (it decides how `<noscript>` content is parsed).
      scriptingEnabled: false,
      treeAdapter: boundedTreeAdapter(bounds),
    });
  }

  // The tokens that can build elements: tags, and text, which re-creates
  // formatting elements.
  override onStartTag(token: Token.TagToken): void {
    this.nextToken();
    super.onStartTag(token);
  }
  override onEndTag(token: Token.TagToken): void {
    this.nextToken();
    super.onEndTag(token);
  }
  override onCharacter(token: Token.CharacterToken): void {
    this.stopIfExceeded();
    super.onCharacter(token);
  }
  override onWhitespaceCharacter(token: Token.CharacterToken): void {
    this.stopIfExceeded();
    super.onWhitespaceCharacter(token);
  }

  private nextToken(): void {
    this.stopIfExceeded();
    this.bounds.tagToken++;
  }

  private stopIfExceeded(): void {
    if (this.bounds.exceeded) throw new TreeTooBig();
  }

  /**
   * The adoption agency moves a block's children into a new element. parse5
   * detaches them from the front one at a time, shifting the rest each time,
   * which took a minute on a block of a few hundred thousand `<br>`s; this
   * moves the list at once.
   */
  override _adoptNodes(donor: Parse5ParentNode, recipient: Parse5ParentNode): void {
    const children = donor.childNodes;
    donor.childNodes = [];
    for (const child of children) {
      child.parentNode = null;
      this.treeAdapter.appendChild(recipient, child);
    }
  }
}

/**
 * parse5's default tree, reporting what it builds to `bounds`. Foster
 * parenting inserts before the open table and the adoption agency detaches an
 * open element, each the last or nearly the last of its parent's children (the
 * agency's moves from the front are {@link BoundedParser}'s). The default
 * adapter finds them searching from the start, which took seconds on a
 * megabyte of `<table><div>`, so this searches from the end.
 */
function boundedTreeAdapter(bounds: TreeBounds): typeof defaultTreeAdapter {
  return {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      bounds.created(attrs);
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    appendChild(parent, node) {
      bounds.placed(parent, node);
      defaultTreeAdapter.appendChild(parent, node);
    },
    insertBefore(parent, node, reference) {
      bounds.placed(parent, node);
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
      bounds.setTemplateHost(content, template);
      defaultTreeAdapter.setTemplateContent(template, content);
    },
  };
}
