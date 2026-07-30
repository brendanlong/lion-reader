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
import { parse, serialize } from "parse5";
import { logger } from "@/lib/logger";

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
  const wrapped = `<!DOCTYPE html><html><body>${html}</body></html>`;

  return parseHTML(normalize(wrapped) ?? wrapped).document.body;
}

/**
 * The markup in tree-construction normal form, or null if parse5 couldn't
 * produce it.
 *
 * parse5's serializer recurses per element, so markup nested a few thousand
 * elements deep overflows the stack — and entry HTML is feed-controlled, which
 * is why the walk itself uses an explicit stack and a depth cap (`./runs`,
 * `./block-elements`). Falling back to linkedom's own parse costs the numbering
 * agreement for that one document, which is what narration did before any of
 * this; throwing would cost the whole request, and on the LLM path it would
 * also record an error that suppresses retries for an hour.
 */
function normalize(wrapped: string): string | null {
  try {
    // `scriptingEnabled: false` matches `DOMParser`, whose documents have
    // scripting disabled (it decides how `<noscript>` content is parsed).
    return serialize(parse(wrapped, { scriptingEnabled: false }));
  } catch (error) {
    logger.warn("Falling back to a non-spec parse of entry HTML for narration", {
      bytes: wrapped.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
