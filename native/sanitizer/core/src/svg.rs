//! Sanitize inline `<svg>` subtrees — port of `src/server/html/sanitize-svg.ts`
//! (issue #923).
//!
//! Each top-level `<svg>` is located by byte range, parsed with the
//! spec-compliant html5ever tree builder (foreign-content parsing adjusts
//! attribute/tag case exactly as a browser does — `viewbox` → `viewBox`,
//! `lineargradient` → `linearGradient` — which is strictly more faithful
//! than the old XML-mode parse), sanitized against a constrained
//! DOMPurify-derived allow-list, and replaced by an opaque per-call-nonced
//! placeholder token that the main lol_html pass passes through as inert
//! text; the sanitized SVG is substituted back in afterwards.
//!
//! Security model (unchanged from the TS implementation): tags are
//! DOMPurify's `svg` + `svgFilters` minus its `svgDisallowed` set, `style`,
//! and the animation elements — so no `<script>`, no `<foreignObject>`
//! arbitrary-HTML escape hatch, no `<use>`, no `<animate attributeName=…>`
//! vector. Attributes are DOMPurify's SVG set minus `style`; `on*` handlers
//! aren't on the list. `href`/`xlink:href` are scheme-validated per element.
//! Disallowed elements are dropped with their subtree.

use scraper::{ElementRef, Html};

use crate::scanner::{find_top_level_ranges, Recovery};
use crate::serialize::{attr_display_name, escape_attr, escape_text};
use crate::urls::{is_data_image, url_scheme};

const ALLOWED_SVG_TAGS: &[&str] = &[
    "svg", "a", "altglyph", "altglyphdef", "altglyphitem", "circle", "clippath", "defs", "desc",
    "ellipse", "filter", "font", "g", "glyph", "glyphref", "hkern", "image", "line",
    "lineargradient", "marker", "mask", "metadata", "path", "pattern", "polygon", "polyline",
    "radialgradient", "rect", "stop", "switch", "symbol", "text", "textpath", "title", "tref",
    "tspan", "view", "vkern",
    // Filter primitives (safe; static rendering only).
    "feblend", "fecolormatrix", "fecomponenttransfer", "fecomposite", "feconvolvematrix",
    "fediffuselighting", "fedisplacementmap", "fedistantlight", "fedropshadow", "feflood",
    "fefunca", "fefuncb", "fefuncg", "fefuncr", "fegaussianblur", "feimage", "femerge",
    "femergenode", "femorphology", "feoffset", "fepointlight", "fespecularlighting",
    "fespotlight", "fetile", "feturbulence",
];

const ALLOWED_SVG_ATTRS: &[&str] = &[
    "accent-height", "accumulate", "additive", "alignment-baseline", "amplitude", "ascent",
    "attributename", "attributetype", "azimuth", "basefrequency", "baseline-shift", "begin",
    "bias", "by", "class", "clip", "clippathunits", "clip-path", "clip-rule", "color",
    "color-interpolation", "color-interpolation-filters", "color-profile", "color-rendering",
    "cx", "cy", "d", "dx", "dy", "diffuseconstant", "direction", "display", "divisor", "dur",
    "edgemode", "elevation", "end", "exponent", "fill", "fill-opacity", "fill-rule", "filter",
    "filterunits", "flood-color", "flood-opacity", "font-family", "font-size",
    "font-size-adjust", "font-stretch", "font-style", "font-variant", "font-weight", "fx",
    "fy", "g1", "g2", "glyph-name", "glyphref", "gradientunits", "gradienttransform",
    "height", "href", "id", "image-rendering", "in", "in2", "intercept", "k", "k1", "k2",
    "k3", "k4", "kerning", "keypoints", "keysplines", "keytimes", "lang", "lengthadjust",
    "letter-spacing", "kernelmatrix", "kernelunitlength", "lighting-color", "local",
    "marker-end", "marker-mid", "marker-start", "markerheight", "markerunits", "markerwidth",
    "maskcontentunits", "maskunits", "max", "mask", "mask-type", "media", "method", "mode",
    "min", "name", "numoctaves", "offset", "operator", "opacity", "order", "orient",
    "orientation", "origin", "overflow", "paint-order", "path", "pathlength",
    "patterncontentunits", "patterntransform", "patternunits", "points", "preservealpha",
    "preserveaspectratio", "primitiveunits", "r", "rx", "ry", "radius", "refx", "refy",
    "repeatcount", "repeatdur", "restart", "result", "rotate", "scale", "seed",
    "shape-rendering", "slope", "specularconstant", "specularexponent", "spreadmethod",
    "startoffset", "stddeviation", "stitchtiles", "stop-color", "stop-opacity",
    "stroke-dasharray", "stroke-dashoffset", "stroke-linecap", "stroke-linejoin",
    "stroke-miterlimit", "stroke-opacity", "stroke", "stroke-width", "surfacescale",
    "systemlanguage", "tabindex", "tablevalues", "targetx", "targety", "transform",
    "transform-origin", "text-anchor", "text-decoration", "text-rendering", "textlength",
    "type", "u1", "u2", "unicode", "values", "viewbox", "visibility", "version",
    "vert-adv-y", "vert-origin-x", "vert-origin-y", "width", "word-spacing", "wrap",
    "writing-mode", "xchannelselector", "ychannelselector", "x", "x1", "x2", "xmlns", "y",
    "y1", "y2", "z", "zoomandpan",
    // Namespaced attributes preserved for well-formed SVG.
    "xlink:href", "xml:space", "xml:lang", "xmlns:xlink",
    // Link attributes on SVG <a> (SVG2); rel/target are forced to safe
    // values for external links.
    "target", "rel",
];

const HREF_HTTP_SCHEMES: &[&str] = &["http", "https", "mailto", "tel"];
const HREF_IMAGE_SCHEMES: &[&str] = &["http", "https", "data"];

/// Whether an `href`/`xlink:href` value is allowed on the given
/// (lowercased) tag.
fn is_href_allowed(tag: &str, value: &str) -> bool {
    let scheme = url_scheme(value);
    if tag == "a" {
        // Links: relative/fragment or a safe navigable scheme.
        return match scheme {
            None => true,
            Some(s) => HREF_HTTP_SCHEMES.contains(&s.as_str()),
        };
    }
    if tag == "image" || tag == "feimage" {
        // Referenced images: same rules as HTML <img> — a `data:` href must be
        // an `image/*` MIME type (so `data:text/html` can't ride in as an
        // image), which still permits `data:image/svg+xml`.
        return match scheme {
            None => true,
            Some(s) => {
                if !HREF_IMAGE_SCHEMES.contains(&s.as_str()) {
                    return false;
                }
                if s == "data" {
                    return is_data_image(value);
                }
                true
            }
        };
    }
    // Every other element references a template within the document; only a
    // same-document `#fragment` ref is allowed.
    value.trim().starts_with('#')
}

/// Whether an `<a>` href points off-site (needs anti-tabnabbing rel).
fn is_external_link(value: &str) -> bool {
    match url_scheme(value) {
        Some(s) => s == "http" || s == "https",
        None => value.trim().starts_with("//"),
    }
}

/// Emit one sanitized SVG element (or nothing, when disallowed — the whole
/// subtree is dropped). Children: elements recurse, text is escaped,
/// everything else (comments, PIs) is dropped.
fn emit_svg_element(el: ElementRef, out: &mut String) {
    let name = el.value().name();
    let lower = name.to_ascii_lowercase();
    if !ALLOWED_SVG_TAGS.contains(&lower.as_str()) {
        return;
    }

    let mut kept: Vec<(String, String)> = Vec::new();
    for (qual_name, value) in el.value().attrs.iter() {
        let display = attr_display_name(qual_name);
        let attr_lower = display.to_ascii_lowercase();
        if !ALLOWED_SVG_ATTRS.contains(&attr_lower.as_str()) {
            continue;
        }
        if (attr_lower == "href" || attr_lower == "xlink:href")
            && !is_href_allowed(&lower, value)
        {
            continue;
        }
        kept.push((display, value.to_string()));
    }
    // External SVG links open in a new browsing context; force a safe rel to
    // prevent reverse-tabnabbing, mirroring the HTML <a> transform (which
    // never sees these — the SVG bypasses the main pass).
    if lower == "a" {
        let href = kept
            .iter()
            .find(|(k, _)| {
                let l = k.to_ascii_lowercase();
                l == "href" || l == "xlink:href"
            })
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        if is_external_link(&href) {
            kept.retain(|(k, _)| {
                let l = k.to_ascii_lowercase();
                l != "target" && l != "rel"
            });
            kept.push(("target".to_string(), "_blank".to_string()));
            kept.push(("rel".to_string(), "noopener noreferrer".to_string()));
        }
    }

    out.push('<');
    out.push_str(name);
    for (k, v) in &kept {
        out.push(' ');
        out.push_str(k);
        out.push_str("=\"");
        escape_attr(v, out);
        out.push('"');
    }

    let mut children = String::new();
    for child in el.children() {
        if let Some(child_el) = ElementRef::wrap(child) {
            emit_svg_element(child_el, &mut children);
        } else if let Some(text) = child.value().as_text() {
            escape_text(text, &mut children);
        }
    }
    if children.is_empty() {
        // XML-style self-close, matching the old dom-serializer xmlMode output.
        out.push_str("/>");
    } else {
        out.push('>');
        out.push_str(&children);
        out.push_str("</");
        out.push_str(name);
        out.push('>');
    }
}

/// Sanitize one `<svg>…</svg>` substring, returning safe SVG markup — or ""
/// when it parses to nothing (so the caller drops it).
fn sanitize_svg_subtree(svg_html: &str) -> String {
    let fragment = Html::parse_fragment(svg_html);
    let svg = fragment
        .tree
        .root()
        .descendants()
        .filter_map(ElementRef::wrap)
        .find(|el| el.value().name().eq_ignore_ascii_case("svg"));
    let Some(svg) = svg else {
        return String::new();
    };
    let mut out = String::new();
    emit_svg_element(svg, &mut out);
    out
}

/// Result of extracting inline SVG.
pub struct SvgExtraction {
    /// Input with each top-level `<svg>` replaced by its placeholder token.
    pub html: String,
    /// Sanitized SVG markup, indexed to match the tokens.
    pub svgs: Vec<String>,
    nonce: String,
}

/// The placeholder token for the `index`-th SVG: index sandwiched between
/// two copies of the nonce so no token is a prefix of another and feeds
/// can't forge one.
fn svg_placeholder(nonce: &str, index: usize) -> String {
    format!("{nonce}{index}{nonce}")
}

fn random_nonce() -> String {
    let mut bytes = [0u8; 12];
    // getrandom failure is unrecoverable enough to warrant the panic — the
    // caller catches it and degrades to "SVG stripped".
    getrandom::fill(&mut bytes).expect("getrandom failed");
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("inlineph{hex}")
}

/// Case-insensitive check for `<svg` without lowercasing the whole body.
fn contains_svg(html: &str) -> bool {
    let bytes = html.as_bytes();
    bytes.windows(4).any(|w| w.eq_ignore_ascii_case(b"<svg"))
}

/// Replace each top-level `<svg>` subtree with an opaque placeholder token,
/// returning the sanitized markup for each. Returns the input unchanged
/// (empty `svgs`) when there is no `<svg>` — a cheap no-op scan.
pub fn extract_inline_svg(html: &str) -> SvgExtraction {
    if !contains_svg(html) {
        return SvgExtraction { html: html.to_string(), svgs: Vec::new(), nonce: String::new() };
    }
    let nonce = random_nonce();
    // Inside <svg>, foreign-content parsing keeps <style>/<script> as
    // markup (rawtext_inside = false); an unclosed svg extends to EOF,
    // matching the old htmlparser2 implied-close behavior.
    let ranges = find_top_level_ranges(html, "svg", &[], false, Recovery::ToEof);
    if ranges.is_empty() {
        return SvgExtraction { html: html.to_string(), svgs: Vec::new(), nonce };
    }

    let mut svgs: Vec<String> = Vec::new();
    let mut result = String::with_capacity(html.len());
    let mut cursor = 0usize;
    for range in &ranges {
        let sanitized = sanitize_svg_subtree(&html[range.start..range.end]);
        result.push_str(&html[cursor..range.start]);
        if !sanitized.is_empty() {
            result.push_str(&svg_placeholder(&nonce, svgs.len()));
            svgs.push(sanitized);
        }
        cursor = range.end;
    }
    if svgs.is_empty() {
        return SvgExtraction { html: html.to_string(), svgs, nonce };
    }
    result.push_str(&html[cursor..]);
    SvgExtraction { html: result, svgs, nonce }
}

/// Substitute the sanitized SVG markup back in for the placeholder tokens,
/// after the main pass has run on the placeholder'd HTML.
pub fn reinsert_inline_svg(html: &str, extraction: &SvgExtraction) -> String {
    let mut result = html.to_string();
    for (i, svg) in extraction.svgs.iter().enumerate() {
        result = result.replace(&svg_placeholder(&extraction.nonce, i), svg);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(html: &str) -> String {
        let extraction = extract_inline_svg(html);
        // Simulate the main pass being a no-op on the placeholder text.
        reinsert_inline_svg(&extraction.html, &extraction)
    }

    #[test]
    fn no_svg_is_a_no_op() {
        let extraction = extract_inline_svg("<p>plain</p>");
        assert_eq!(extraction.html, "<p>plain</p>");
        assert!(extraction.svgs.is_empty());
    }

    #[test]
    fn preserves_camel_case_attributes() {
        let out = roundtrip(r#"<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>"#);
        assert!(out.contains(r#"viewBox="0 0 10 10""#), "{out}");
        assert!(out.contains("<circle"));
    }

    #[test]
    fn case_folded_input_is_adjusted_back() {
        // Browsers adjust known SVG attributes/tags to canonical case; the
        // html5ever foreign-content parse does the same.
        let out = roundtrip(r#"<svg viewbox="0 0 10 10"><lineargradient id="g"/></svg>"#);
        assert!(out.contains(r#"viewBox="0 0 10 10""#), "{out}");
        assert!(out.contains("<linearGradient"), "{out}");
    }

    #[test]
    fn drops_script_and_event_handlers() {
        let out = roundtrip(r#"<svg onload="alert(1)"><script>alert(1)</script><circle onclick="x" r="1"/></svg>"#);
        assert!(!out.contains("script"), "{out}");
        assert!(!out.contains("onload"), "{out}");
        assert!(!out.contains("onclick"), "{out}");
        assert!(out.contains("<circle r=\"1\"/>"), "{out}");
    }

    #[test]
    fn drops_foreign_object_subtree() {
        let out = roundtrip(r#"<svg><foreignObject><img src="x" onerror="alert(1)"></foreignObject><rect width="5"/></svg>"#);
        assert!(!out.to_lowercase().contains("foreignobject"), "{out}");
        assert!(!out.contains("img"), "{out}");
        assert!(out.contains("<rect width=\"5\"/>"), "{out}");
    }

    #[test]
    fn href_rules_per_element() {
        let out = roundtrip(
            r#"<svg><a href="javascript:alert(1)"><text>bad</text></a><a href="https://x.com"><text>ok</text></a><linearGradient href="https://evil.com/g"/><image href="data:image/png;base64,AA=="/></svg>"#,
        );
        assert!(!out.contains("javascript:"), "{out}");
        assert!(out.contains(r#"href="https://x.com""#), "{out}");
        assert!(out.contains(r#"rel="noopener noreferrer""#), "{out}");
        // Non-image/non-a href must be a #fragment ref.
        assert!(!out.contains("evil.com"), "{out}");
        assert!(out.contains("data:image/png"), "{out}");
    }

    #[test]
    fn multiple_svgs_reinsert_in_order() {
        let html = r#"<p>a</p><svg id="one"/><p>b</p><svg id="two"/>"#;
        let extraction = extract_inline_svg(html);
        assert_eq!(extraction.svgs.len(), 2);
        let out = reinsert_inline_svg(&extraction.html, &extraction);
        let one = out.find("id=\"one\"").unwrap();
        let two = out.find("id=\"two\"").unwrap();
        assert!(one < two, "{out}");
    }
}
