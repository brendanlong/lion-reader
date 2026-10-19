/**
 * The app's only constructor of htmlparser2 parsers (a lint rule enforces it).
 */

import { Parser, type Handler, type ParserOptions } from "htmlparser2";

/**
 * Deepest element nesting a SAX parse reads. htmlparser2 keeps its open
 * elements in an array it shifts and searches on every tag, so each tag costs
 * time proportional to the current depth, and markup nested tens of thousands
 * deep takes seconds to parse (#2031). Like `MAX_DOM_DEPTH` in the native
 * crates, this sits far above anything real: articles nest a few dozen levels
 * and Blink flattens the tree beyond 512.
 */
export const MAX_SAX_DEPTH = 512;

/**
 * An htmlparser2 parser that stops for good, as if paused, when an element
 * would nest deeper than {@link MAX_SAX_DEPTH} (a void element directly at
 * the limit counts). Handlers may still see the rest of that tag, but nothing
 * after it, including the implied closes at the end; they keep what they've
 * collected so far.
 */
export function createSaxParser(handlers: Partial<Handler>, options?: ParserOptions): Parser {
  let depth = 0;
  const parser = new Parser(
    {
      ...handlers,
      onopentagname(name) {
        if (++depth > MAX_SAX_DEPTH) {
          parser.pause();
          return;
        }
        handlers.onopentagname?.(name);
      },
      onclosetag(name, isImplied) {
        depth--;
        handlers.onclosetag?.(name, isImplied);
      },
    },
    options
  );
  return parser;
}
