/**
 * Server-side HTML sanitization for entry content.
 *
 * Entry bodies come from untrusted feeds and are rendered in the browser via
 * `dangerouslySetInnerHTML`, so they must be sanitized before they reach the
 * client. We do this on the server (read path) with `sanitize-html`, a pure
 * Node sanitizer built on the `htmlparser2` we already use — no DOM/jsdom
 * required. The client then renders trusted HTML and ships no sanitizer.
 *
 * This replaces the previous client-side `isomorphic-dompurify` (which pulled
 * `jsdom` into the server bundle). The allow-list is intentionally permissive
 * to match what DOMPurify let through, while the `transformTags` reproduce the
 * old `afterSanitizeAttributes` hook (external links open in a new tab; images
 * lazy-load).
 */

import sanitizeHtml from "sanitize-html";

import { logger } from "@/lib/logger";
import { convertMathJaxChtmlToMathml } from "./mathjax-chtml";

/**
 * Version of the sanitization config. Bump this whenever `SANITIZE_OPTIONS`
 * (allowed tags/attributes/schemes or `transformTags`) or the pre-sanitization
 * transforms (`convertMathJaxChtmlToMathml`) change.
 *
 * Sanitized entry HTML is persisted in the database (`entries.*_sanitized`,
 * stamped with `*_sanitized_version`; see `withSanitizedEntryContent` in
 * `sanitize-entry.ts`). The read path (`resolveSanitizedContent` in the entries
 * router) compares the stored version against this constant and re-sanitizes
 * from the raw columns when they differ — so bumping this value marks every row
 * stale and transparently re-sanitizes it on next read instead of serving stale
 * output.
 */
export const SANITIZER_VERSION = 4;

// Tags allowed in entry content. Superset of sanitize-html's defaults covering
// the formatting, table, and media elements real articles use. `script` and
// `style` are deliberately excluded (no executable content, no style-tag CSS).
const ALLOWED_TAGS = [
  // Sections & blocks
  "p",
  "div",
  "span",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "aside",
  "nav",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "hr",
  "br",
  "figure",
  "figcaption",
  "details",
  "summary",
  "address",
  // Inline text semantics
  "a",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "del",
  "ins",
  "mark",
  "small",
  "sub",
  "sup",
  "abbr",
  "cite",
  "q",
  "code",
  "kbd",
  "samp",
  "var",
  "time",
  "wbr",
  "bdi",
  "bdo",
  "ruby",
  "rt",
  "rp",
  "dfn",
  // Lists
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  // Tables
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "colgroup",
  "col",
  // Media
  "img",
  "picture",
  "source",
  "audio",
  "video",
  "track",
  "iframe",
];

// Presentation MathML, allowed so equations render natively (modern browsers
// render MathML Core without any JS/MathJax). Tags/attrs are lowercase, so
// sanitize-html's name-folding doesn't break them. Deliberately excluded:
// `semantics`/`annotation`/`annotation-xml` (the latter with encoding=text/html
// is a known mutation-XSS vector), and `href` on MathML elements.
const MATHML_TAGS = [
  "math",
  "mrow",
  "mi",
  "mo",
  "mn",
  "ms",
  "mtext",
  "mspace",
  "msup",
  "msub",
  "msubsup",
  "mfrac",
  "msqrt",
  "mroot",
  "mover",
  "munder",
  "munderover",
  "mmultiscripts",
  "mprescripts",
  "mtable",
  "mtr",
  "mtd",
  "mlabeledtr",
  "mpadded",
  "mphantom",
  "menclose",
  "mstyle",
  "merror",
  "maction",
];

// MathML presentation attributes (no `href`, no event handlers).
const MATHML_ATTRS = [
  "displaystyle",
  "scriptlevel",
  "mathvariant",
  "mathcolor",
  "mathbackground",
  "dir",
  "display",
  "linethickness",
  "fence",
  "separator",
  "stretchy",
  "symmetric",
  "largeop",
  "movablelimits",
  "accent",
  "accentunder",
  "lspace",
  "rspace",
  "width",
  "height",
  "depth",
  "voffset",
  "open",
  "close",
  "separators",
  "notation",
  "columnalign",
  "rowalign",
  "columnspan",
  "rowspan",
  "columnlines",
  "rowlines",
  "subscriptshift",
  "superscriptshift",
];

// Global attributes allowed on any element. `data-*` mirrors DOMPurify's
// default (data attributes are inert) and covers the narration `data-para-id`.
const GLOBAL_ATTRS = ["class", "id", "title", "dir", "lang", "data-*"];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_TAGS, ...MATHML_TAGS],
  allowedAttributes: {
    "*": [...GLOBAL_ATTRS, ...MATHML_ATTRS],
    math: [...GLOBAL_ATTRS, ...MATHML_ATTRS, "xmlns"],
    a: [...GLOBAL_ATTRS, "href", "name", "target", "rel"],
    img: [
      ...GLOBAL_ATTRS,
      "src",
      "srcset",
      "sizes",
      "alt",
      "width",
      "height",
      "loading",
      "decoding",
    ],
    source: [...GLOBAL_ATTRS, "src", "srcset", "type", "media", "sizes"],
    iframe: [
      ...GLOBAL_ATTRS,
      "src",
      "width",
      "height",
      "allow",
      "allowfullscreen",
      "frameborder",
      "loading",
      "referrerpolicy",
      "sandbox",
    ],
    video: [
      ...GLOBAL_ATTRS,
      "src",
      "poster",
      "width",
      "height",
      "controls",
      "loop",
      "muted",
      "preload",
    ],
    audio: [...GLOBAL_ATTRS, "src", "controls", "loop", "muted", "preload"],
    track: [...GLOBAL_ATTRS, "src", "kind", "srclang", "label", "default"],
    th: [...GLOBAL_ATTRS, "colspan", "rowspan", "scope", "headers"],
    td: [...GLOBAL_ATTRS, "colspan", "rowspan", "headers"],
    col: [...GLOBAL_ATTRS, "span"],
    colgroup: [...GLOBAL_ATTRS, "span"],
    time: [...GLOBAL_ATTRS, "datetime"],
  },
  // Only safe URL schemes. `on*` event-handler attributes are never in the
  // allow-list, so they're dropped regardless.
  allowedSchemes: ["http", "https", "mailto", "tel"],
  // Feeds embed base64 images; allow data: URIs for <img>/<source> only.
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
    source: ["http", "https", "data"],
  },
  allowProtocolRelative: true,
  transformTags: {
    // External links open in a new tab with a safe rel (was the old
    // afterSanitizeAttributes hook). Relative/in-page links are left alone.
    // Normalize case/whitespace and treat protocol-relative `//host` as
    // external so those links still get rel=noopener (anti reverse-tabnabbing).
    // Note: `javascript:` etc. are stripped by sanitize-html's scheme filter
    // regardless of this check, which only gates the target/rel addition.
    a: (tagName, attribs) => {
      const href = (attribs.href ?? "").trim().toLowerCase();
      const isExternal =
        href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//");
      if (isExternal) {
        return {
          tagName,
          attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" },
        };
      }
      return { tagName, attribs };
    },
    // Lazy-load all images.
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: "lazy" } }),
  },
};

/**
 * Sanitizes untrusted entry HTML for safe rendering in the browser.
 *
 * Returns `null` for `null`/empty input so callers can pass through nullable
 * content fields unchanged.
 */
export function sanitizeEntryHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  // Convert MathJax CHTML to MathML first so equations survive sanitization.
  // No-op (cheap string check) for the common case with no embedded math. This
  // runs on untrusted bodies at ingest time, so a pathological input (e.g.
  // extreme nesting overflowing the recursion) must degrade to "math stripped"
  // rather than crash the write path — fall back to the raw HTML on error.
  let transformed = html;
  try {
    transformed = convertMathJaxChtmlToMathml(html);
  } catch (error) {
    logger.warn("Failed to convert MathJax CHTML to MathML; sanitizing raw HTML", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return sanitizeHtml(transformed, SANITIZE_OPTIONS);
}
