/**
 * Sanitize inline `<svg>` subtrees for safe rendering in entry content.
 *
 * ## Why this can't live inside `sanitize-html`
 *
 * Our main entry sanitizer (`sanitize.ts`) is `sanitize-html`, which parses in
 * `htmlparser2` **HTML mode** and therefore **case-folds** tag and attribute
 * names. SVG depends on camelCase (`viewBox`, `preserveAspectRatio`,
 * `linearGradient`, `clipPath`, `gradientUnits`…): case-folded SVG renders
 * broken (`viewBox` → `viewbox` is ignored by the browser). Turning off
 * case-folding is a **global** parser option, and disabling it would break the
 * surrounding HTML allow-list matching (`<DIV>` would no longer match `div`).
 * A single pass can't have it both ways, so `sanitize-html` simply drops
 * `<svg>` — a content-fidelity regression for feeds that embed inline SVG
 * diagrams/charts (issue #923).
 *
 * ## Approach: a case-preserving second pass, isolated from `sanitize-html`
 *
 * This module runs as a **pre-sanitization transform** (like
 * `convertMathJaxChtmlToMathml`). It locates each top-level `<svg>` subtree by
 * byte range in a single streaming pass, sanitizes it against a constrained,
 * case-preserving SVG allow-list (parsing each subtree in **XML mode** so the
 * camelCase survives and HTML auto-closing rules don't corrupt it), and
 * replaces the original SVG with an opaque placeholder token. The token is a
 * bare alphanumeric string, so `sanitize-html` passes it through untouched as a
 * text node; the caller substitutes the sanitized SVG back in afterwards. This
 * keeps SVG entirely out of `sanitize-html`'s case-folding hands while still
 * running the rest of the body through it.
 *
 * The placeholder token embeds a per-call random nonce so a hostile feed can't
 * forge one to mis-place content (and even if it collided, the substituted
 * value is our own already-sanitized SVG, so there's no injection).
 *
 * ## Security model
 *
 * The allow-list is derived from DOMPurify's battle-tested SVG profile
 * (`src` verified against dompurify 3.4.11), further constrained:
 *
 * - **Tags**: DOMPurify's `svg` + `svgFilters` sets, minus everything in its
 *   `svgDisallowed` set (`script`, `foreignObject`, `use`, animation elements,
 *   `font-face*`, `mesh*`, …) and minus `style` (we allow no CSS anywhere, in
 *   line with the HTML policy) and the remaining animation elements
 *   (`animateColor`/`animateMotion`/`animateTransform`) — so there is no
 *   `<animate attributeName="href">`-style vector and no `<foreignObject>`
 *   arbitrary-HTML escape hatch. Disallowed elements are dropped **with their
 *   subtree**.
 * - **Attributes**: DOMPurify's `svg` attribute set (minus `style`), matched
 *   case-insensitively but emitted with original case. `on*` handlers are not
 *   on the list, so they're dropped. `href`/`xlink:href` are scheme-validated
 *   per element: `<a>` allows only http/https/mailto/tel/relative;
 *   `<image>`/`<feImage>` additionally allow `data:`; every other element
 *   (gradient/pattern/filter template references) allows only same-document
 *   `#fragment` refs. `javascript:` (and any other scheme) is dropped.
 */

import { render } from "dom-serializer";
import { type ChildNode, type Document, Element, isTag } from "domhandler";
import { parseDocument, Parser } from "htmlparser2";
import { randomBytes } from "node:crypto";

// DOMPurify's SVG element allow-list (`svg` + `svgFilters`), minus its
// `svgDisallowed` set and minus `style` and the remaining animation elements.
// Stored lowercased; the parsed element names are compared case-insensitively.
const ALLOWED_SVG_TAGS = new Set([
  "svg",
  "a",
  "altglyph",
  "altglyphdef",
  "altglyphitem",
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "filter",
  "font",
  "g",
  "glyph",
  "glyphref",
  "hkern",
  "image",
  "line",
  "lineargradient",
  "marker",
  "mask",
  "metadata",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "switch",
  "symbol",
  "text",
  "textpath",
  "title",
  "tref",
  "tspan",
  "view",
  "vkern",
  // Filter primitives (safe; static rendering only).
  "feblend",
  "fecolormatrix",
  "fecomponenttransfer",
  "fecomposite",
  "feconvolvematrix",
  "fediffuselighting",
  "fedisplacementmap",
  "fedistantlight",
  "fedropshadow",
  "feflood",
  "fefunca",
  "fefuncb",
  "fefuncg",
  "fefuncr",
  "fegaussianblur",
  "feimage",
  "femerge",
  "femergenode",
  "femorphology",
  "feoffset",
  "fepointlight",
  "fespecularlighting",
  "fespotlight",
  "fetile",
  "feturbulence",
]);

// DOMPurify's SVG attribute allow-list, minus `style` (no CSS). Lowercased for
// case-insensitive lookup; `href`/`xlink:href` get extra scheme validation.
const ALLOWED_SVG_ATTRS = new Set([
  "accent-height",
  "accumulate",
  "additive",
  "alignment-baseline",
  "amplitude",
  "ascent",
  "attributename",
  "attributetype",
  "azimuth",
  "basefrequency",
  "baseline-shift",
  "begin",
  "bias",
  "by",
  "class",
  "clip",
  "clippathunits",
  "clip-path",
  "clip-rule",
  "color",
  "color-interpolation",
  "color-interpolation-filters",
  "color-profile",
  "color-rendering",
  "cx",
  "cy",
  "d",
  "dx",
  "dy",
  "diffuseconstant",
  "direction",
  "display",
  "divisor",
  "dur",
  "edgemode",
  "elevation",
  "end",
  "exponent",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "filterunits",
  "flood-color",
  "flood-opacity",
  "font-family",
  "font-size",
  "font-size-adjust",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "fx",
  "fy",
  "g1",
  "g2",
  "glyph-name",
  "glyphref",
  "gradientunits",
  "gradienttransform",
  "height",
  "href",
  "id",
  "image-rendering",
  "in",
  "in2",
  "intercept",
  "k",
  "k1",
  "k2",
  "k3",
  "k4",
  "kerning",
  "keypoints",
  "keysplines",
  "keytimes",
  "lang",
  "lengthadjust",
  "letter-spacing",
  "kernelmatrix",
  "kernelunitlength",
  "lighting-color",
  "local",
  "marker-end",
  "marker-mid",
  "marker-start",
  "markerheight",
  "markerunits",
  "markerwidth",
  "maskcontentunits",
  "maskunits",
  "max",
  "mask",
  "mask-type",
  "media",
  "method",
  "mode",
  "min",
  "name",
  "numoctaves",
  "offset",
  "operator",
  "opacity",
  "order",
  "orient",
  "orientation",
  "origin",
  "overflow",
  "paint-order",
  "path",
  "pathlength",
  "patterncontentunits",
  "patterntransform",
  "patternunits",
  "points",
  "preservealpha",
  "preserveaspectratio",
  "primitiveunits",
  "r",
  "rx",
  "ry",
  "radius",
  "refx",
  "refy",
  "repeatcount",
  "repeatdur",
  "restart",
  "result",
  "rotate",
  "scale",
  "seed",
  "shape-rendering",
  "slope",
  "specularconstant",
  "specularexponent",
  "spreadmethod",
  "startoffset",
  "stddeviation",
  "stitchtiles",
  "stop-color",
  "stop-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke",
  "stroke-width",
  "surfacescale",
  "systemlanguage",
  "tabindex",
  "tablevalues",
  "targetx",
  "targety",
  "transform",
  "transform-origin",
  "text-anchor",
  "text-decoration",
  "text-rendering",
  "textlength",
  "type",
  "u1",
  "u2",
  "unicode",
  "values",
  "viewbox",
  "visibility",
  "version",
  "vert-adv-y",
  "vert-origin-x",
  "vert-origin-y",
  "width",
  "word-spacing",
  "wrap",
  "writing-mode",
  "xchannelselector",
  "ychannelselector",
  "x",
  "x1",
  "x2",
  "xmlns",
  "y",
  "y1",
  "y2",
  "z",
  "zoomandpan",
  // Namespaced attributes preserved for well-formed SVG.
  "xlink:href",
  "xml:space",
  "xml:lang",
  "xmlns:xlink",
  // Link attributes on SVG <a> (SVG2); `rel`/`target` are also forced to safe
  // values for external links by `sanitizeAttributes` (anti reverse-tabnabbing).
  "target",
  "rel",
]);

// Elements whose `href`/`xlink:href` may carry a fetchable URL rather than only
// a same-document `#fragment` template reference.
const HREF_HTTP_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const HREF_IMAGE_SCHEMES = new Set(["http", "https", "data"]);

/** The URL scheme of `value` (lowercased), or null when it has none (relative/fragment). */
function urlScheme(value: string): string | null {
  // Strip whitespace/control chars an attacker could use to hide the scheme
  // (e.g. `java\tscript:`); entities are already decoded by the parser.
  const cleaned = value.replace(/[\u0000-\u0020]+/g, "").toLowerCase();
  const match = cleaned.match(/^([a-z][a-z0-9+.-]*):/);
  return match ? match[1] : null;
}

/** Whether an `href`/`xlink:href` value is allowed on the given (lowercased) tag. */
function isHrefAllowed(tag: string, value: string): boolean {
  const scheme = urlScheme(value);
  if (tag === "a") {
    // Links: relative/fragment or a safe navigable scheme. No javascript:/data:.
    return scheme === null || HREF_HTTP_SCHEMES.has(scheme);
  }
  if (tag === "image" || tag === "feimage") {
    // Referenced images: same rules as HTML <img> (any `data:` URI allowed, not
    // just image media types, matching `sanitize.ts`'s img policy — the referent
    // renders as an image resource with scripting disabled, so `data:text/html`
    // is inert here). No `javascript:`/other schemes.
    return scheme === null || HREF_IMAGE_SCHEMES.has(scheme);
  }
  // Every other element references a template within the document; only allow a
  // same-document `#fragment` so an external/`javascript:` ref can't slip in.
  return value.trim().startsWith("#");
}

/** Whether an `<a>` href points off-site (so it needs anti-tabnabbing `rel`). */
function isExternalLink(value: string): boolean {
  const scheme = urlScheme(value);
  // http(s) or protocol-relative `//host` (urlScheme returns null for the latter).
  return scheme === "http" || scheme === "https" || value.trim().startsWith("//");
}

/** Filter one element's attributes in place against the allow-list + href rules. */
function sanitizeAttributes(el: Element): void {
  const tag = el.name.toLowerCase();
  const kept: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(el.attribs)) {
    const name = rawName.toLowerCase();
    if (!ALLOWED_SVG_ATTRS.has(name)) continue;
    if (name === "href" || name === "xlink:href") {
      if (!isHrefAllowed(tag, value)) continue;
    }
    kept[rawName] = value;
  }
  // External SVG links open in a new browsing context; force a safe rel to
  // prevent reverse-tabnabbing, mirroring the HTML `<a>` transform in
  // `sanitize.ts` (which never sees these, since the SVG bypasses sanitize-html).
  if (tag === "a" && isExternalLink(kept.href ?? kept["xlink:href"] ?? "")) {
    kept.target = "_blank";
    kept.rel = "noopener noreferrer";
  }
  el.attribs = kept;
}

/** Recursively drop disallowed elements/attributes; returns the kept children. */
function sanitizeSvgChildren(children: ChildNode[]): ChildNode[] {
  const kept: ChildNode[] = [];
  for (const child of children) {
    if (isTag(child)) {
      if (!ALLOWED_SVG_TAGS.has(child.name.toLowerCase())) continue; // drop subtree
      sanitizeAttributes(child);
      child.children = sanitizeSvgChildren(child.children);
      for (const grandchild of child.children) grandchild.parent = child;
      kept.push(child);
    } else if (child.type === "text") {
      kept.push(child);
    }
    // Comments, CDATA, processing instructions, etc. are dropped.
  }
  return kept;
}

/** The first `<svg>` element child of a parsed document, or null. */
function findSvgRoot(doc: Document): Element | null {
  for (const child of doc.children) {
    if (isTag(child) && child.name.toLowerCase() === "svg") return child;
  }
  return null;
}

/**
 * Sanitize one `<svg>…</svg>` substring, returning safe SVG markup — or "" when
 * it parses to nothing (so the caller can drop it). Parsed in XML mode so
 * camelCase survives and HTML auto-closing rules don't corrupt the subtree.
 */
function sanitizeSvgSubtree(svgHtml: string): string {
  const doc = parseDocument(svgHtml, { xmlMode: true, decodeEntities: true });
  const svg = findSvgRoot(doc);
  if (!svg) return "";
  sanitizeAttributes(svg);
  svg.children = sanitizeSvgChildren(svg.children);
  for (const child of svg.children) child.parent = svg;
  return render(svg, { xmlMode: true, encodeEntities: "utf8" });
}

/** Result of extracting inline SVG: HTML with placeholder tokens + the sanitized SVGs. */
export interface InlineSvgExtraction {
  /** Input with each top-level `<svg>` replaced by its placeholder token. */
  html: string;
  /** Sanitized SVG markup, indexed to match the tokens (`token(i)` → `svgs[i]`). */
  svgs: string[];
  /** The per-call nonce; combine with an index via `svgPlaceholder`. */
  nonce: string;
}

/** The placeholder token for the `index`-th SVG under a given nonce. */
function svgPlaceholder(nonce: string, index: number): string {
  // Index sandwiched between two copies of the nonce so no token is a prefix of
  // another (collision-free string substitution) and feeds can't forge one.
  return `${nonce}${index}${nonce}`;
}

/**
 * Replace each top-level `<svg>` subtree in `html` with an opaque placeholder
 * token and return the sanitized SVG markup for each. Returns the input
 * unchanged (empty `svgs`) when there is no `<svg>` — a cheap no-op for the
 * common case.
 *
 * The locating pass runs in HTML mode (matching the surrounding document) and
 * only tracks `<svg>` open/close depth to find byte ranges; each located
 * substring is then re-parsed and sanitized in XML mode by `sanitizeSvgSubtree`.
 */
export function extractInlineSvg(html: string): InlineSvgExtraction {
  // Cheap no-op for the common (no-SVG) case: a case-insensitive scan that
  // does NOT allocate a lowercased copy of the (possibly large) body, and skip
  // the nonce until we know we need one. `<SVG` etc. are valid, hence `/i`.
  if (!/<svg/i.test(html)) {
    return { html, svgs: [], nonce: "" };
  }
  const nonce = `inlineph${randomBytes(12).toString("hex")}`;

  const svgs: string[] = [];
  let result = "";
  // Position up to which `html` has been copied into `result` verbatim.
  let cursor = 0;
  // Byte offset of the current top-level `<svg>`'s opening `<`.
  let svgStart = -1;
  // Nesting depth of `<svg>` (0 = outside any svg).
  let depth = 0;

  const parser: Parser = new Parser(
    {
      onopentag(name) {
        if (name.toLowerCase() !== "svg") return;
        if (depth === 0) svgStart = parser.startIndex;
        depth++;
      },
      onclosetag(name) {
        if (name.toLowerCase() !== "svg" || depth === 0) return;
        depth--;
        if (depth > 0) return;
        // Left the top-level svg: splice the verbatim prefix, then the placeholder.
        const svgEnd = parser.endIndex + 1;
        const sanitized = sanitizeSvgSubtree(html.slice(svgStart, svgEnd));
        result += html.slice(cursor, svgStart);
        if (sanitized) {
          result += svgPlaceholder(nonce, svgs.length);
          svgs.push(sanitized);
        }
        cursor = svgEnd;
      },
    },
    { decodeEntities: true, recognizeSelfClosing: true }
  );
  parser.write(html);
  parser.end();

  if (svgs.length === 0) return { html, svgs: [], nonce };
  result += html.slice(cursor);
  return { html: result, svgs, nonce };
}

/**
 * Substitute the sanitized SVG markup back in for the placeholder tokens left
 * by `extractInlineSvg`, after `sanitize-html` has run on the placeholder'd HTML.
 */
export function reinsertInlineSvg(html: string, extraction: InlineSvgExtraction): string {
  let result = html;
  for (let i = 0; i < extraction.svgs.length; i++) {
    result = result.split(svgPlaceholder(extraction.nonce, i)).join(extraction.svgs[i]);
  }
  return result;
}
