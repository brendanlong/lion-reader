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

// Global attributes allowed on any element. `data-*` mirrors DOMPurify's
// default (data attributes are inert) and covers the narration `data-para-id`.
const GLOBAL_ATTRS = ["class", "id", "title", "dir", "lang", "data-*"];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    "*": GLOBAL_ATTRS,
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
    a: (tagName, attribs) => {
      const href = attribs.href ?? "";
      if (href.startsWith("http://") || href.startsWith("https://")) {
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
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}
