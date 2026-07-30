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
 * isomorphic code it is. It costs a second parse (~2× the linkedom-only cost,
 * ~50ms for a 200 KB body), which is small against the LLM call it feeds.
 *
 * Server-only: both parsers are. Do not import this from a client component.
 *
 * @module narration/parse-html
 */

import { parseHTML } from "linkedom";
import { parse, serialize } from "parse5";

/**
 * Parses entry HTML into a `<body>` element holding the tree a browser builds
 * from the same string.
 *
 * @param html - The (already sanitized) entry HTML
 * @returns The body element of the parsed document
 */
export function parseBodyAsBrowser(html: string): Element {
  // Wrapped in a document so the content parses in "in body" insertion mode —
  // the mode the client's `DOMParser` call uses for the same string.
  // `scriptingEnabled: false` matches `DOMParser`, whose documents have
  // scripting disabled (it decides how `<noscript>` content is parsed).
  const document = parse(`<!DOCTYPE html><html><body>${html}</body></html>`, {
    scriptingEnabled: false,
  });

  return parseHTML(serialize(document)).document.body;
}
