//! The main HTML allow-list pass — port of `SANITIZE_OPTIONS` from
//! `src/server/html/sanitize.ts`, running on lol_html (streaming, no tree).
//!
//! Semantics ported from sanitize-html:
//! - Tags not on the allow-list are unwrapped (children kept), except the
//!   "non-text" tags (`script`/`style`/`textarea`/`option`) whose content is
//!   dropped with them.
//! - Attributes are allow-listed globally (`class`/`id`/`title`/`dir`/
//!   `lang`/`role`, `data-*`, `aria-*`, the MathML presentation set) plus
//!   per-tag additions. `role`/`aria-*` are inert ARIA hooks kept for
//!   assistive tech (e.g. `role="doc-noteref"` on footnotes).
//! - URL-carrying attributes are scheme-checked (http/https/mailto/tel;
//!   `data:image/*` additionally for img/source), on the entity-decoded value.
//!   Protocol-relative and relative URLs pass. `data:` is accepted only when
//!   its MIME type is `image/*` (so `data:text/html` never reaches an image
//!   sink); `data:image/svg+xml` is allowed because an SVG in an image context
//!   is passive (see `is_image_url_allowed`).
//! - Comments and doctypes are removed.
//! - Transforms: external links get `target="_blank" rel="noopener
//!   noreferrer"`; images get `loading="lazy"`; iframes survive only as
//!   normalized allow-listed embeds with a forced sandbox.
//!
//! Unlike sanitize-html, lol_html does not re-serialize untouched markup:
//! kept text and attribute values pass through byte-identical, and the
//! tokenizer is HTML5-spec-conformant (the same tokenization a browser
//! does), which removes the parser-differential class of bypasses.

use lol_html::html_content::Element;
use lol_html::{doc_comments, doctype, element, HtmlRewriter, Settings};

use crate::embeds::normalize_embed;
use crate::urls::{decode_attr, is_image_url_allowed};

/// Tags allowed in entry content (sanitize.ts ALLOWED_TAGS + MATHML_TAGS).
const ALLOWED_TAGS: &[&str] = &[
    // Sections & blocks
    "p", "div", "span", "section", "article", "header", "footer", "main", "aside", "nav",
    "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr", "br", "figure",
    "figcaption", "details", "summary", "address",
    // Inline text semantics
    "a", "b", "strong", "i", "em", "u", "s", "strike", "del", "ins", "mark", "small", "sub",
    "sup", "abbr", "cite", "q", "code", "kbd", "samp", "var", "time", "wbr", "bdi", "bdo",
    "ruby", "rt", "rp", "dfn",
    // Lists
    "ul", "ol", "li", "dl", "dt", "dd",
    // Tables
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
    // Media
    "img", "picture", "source", "audio", "video", "track",
    // `iframe` is allowed ONLY for allow-listed media-embed providers (issue
    // #922): handle_iframe validates the src against normalize_embed and
    // rewrites it to the provider's canonical host with a forced sandbox;
    // anything else is removed entirely.
    "iframe",
    // Presentation MathML (MathML Core renders natively). Deliberately
    // excluded: semantics/annotation/annotation-xml (mXSS vector) and href.
    "math", "mrow", "mi", "mo", "mn", "ms", "mtext", "mspace", "msup", "msub", "msubsup",
    "mfrac", "msqrt", "mroot", "mover", "munder", "munderover", "mmultiscripts",
    "mprescripts", "mtable", "mtr", "mtd", "mlabeledtr", "mpadded", "mphantom", "menclose",
    "mstyle", "merror", "maction",
];

/// Disallowed tags whose content is dropped along with them, rather than
/// unwrapped (children kept).
///
/// This is `sanitize-html`'s `nonTextTags` default (`script`/`style`/
/// `textarea`/`option`) **plus every other element the HTML tokenizer treats
/// as raw text / RCDATA / escapable-raw-text**. That second set is critical
/// for XSS safety, not cosmetic: inside `<title>`/`<xmp>`/`<noembed>`/
/// `<noframes>`/`<noscript>`/`<plaintext>` the tokenizer reads the contents
/// as a single *text* run, so lol_html's `*` element handler never fires on
/// any markup in there. If we merely unwrapped the element, lol_html would
/// re-emit that text **verbatim** (it is a raw text chunk, not parsed
/// content), and since it is no longer inside a rawtext element the browser
/// re-parses it as live markup — e.g. `<title><img src=x onerror=alert(1)>`
/// would round-trip to an executing `<img>`. Dropping the whole subtree
/// closes that mutation-XSS path. (`iframe` is also a rawtext element but is
/// allow-listed and handled separately in `handle_iframe`, so it never
/// reaches here.)
const DROP_WITH_CONTENT: &[&str] = &[
    "script", "style", "textarea", "option", "title", "xmp", "noembed", "noframes", "noscript",
    "plaintext",
];

/// Global attributes allowed on any element (`data-*` and `aria-*` handled
/// separately). `role` and `aria-*` are ARIA hooks: inert (no script, no URL,
/// no resource load), preserved byte-identically by lol_html, and required for
/// assistive tech — e.g. LessWrong footnotes carry `role="doc-noteref"` /
/// `"doc-endnotes"` / `"doc-endnote"` that screen readers announce as
/// footnotes. Allowing them matches DOMPurify's default ARIA handling.
const GLOBAL_ATTRS: &[&str] = &["class", "id", "title", "dir", "lang", "role"];

/// MathML presentation attributes — allowed on every element, matching
/// sanitize.ts's `allowedAttributes["*"]` (no `href`, no event handlers).
const MATHML_ATTRS: &[&str] = &[
    "displaystyle", "scriptlevel", "mathvariant", "mathcolor", "mathbackground", "dir",
    "display", "linethickness", "fence", "separator", "stretchy", "symmetric", "largeop",
    "movablelimits", "accent", "accentunder", "lspace", "rspace", "width", "height", "depth",
    "voffset", "open", "close", "separators", "notation", "columnalign", "rowalign",
    "columnspan", "rowspan", "columnlines", "rowlines", "subscriptshift", "superscriptshift",
];

const SAFE_SCHEMES: &[&str] = &["http", "https", "mailto", "tel"];
// img/source src (and srcset candidates): http/https + data URIs (feeds embed
// base64 images). Deliberately NOT mailto/tel — matches the old
// `allowedSchemesByTag` for img/source exactly. `data:` is MIME-gated to
// `image/*` by `is_image_url_allowed` (a `data:text/html` image source would
// otherwise be a stored-HTML sink), which still permits `data:image/svg+xml`
// since an SVG rendered as an image is passive.
const IMAGE_SCHEMES: &[&str] = &["http", "https", "data"];

fn tag_allowed(tag: &str) -> bool {
    ALLOWED_TAGS.contains(&tag)
}

fn attr_allowed(tag: &str, name: &str) -> bool {
    if GLOBAL_ATTRS.contains(&name)
        || MATHML_ATTRS.contains(&name)
        || name.starts_with("data-")
        || name.starts_with("aria-")
    {
        return true;
    }
    match tag {
        "a" => matches!(name, "href" | "name" | "target" | "rel"),
        "img" => matches!(
            name,
            "src" | "srcset" | "sizes" | "alt" | "width" | "height" | "loading" | "decoding"
        ),
        "source" => matches!(name, "src" | "srcset" | "type" | "media" | "sizes"),
        "video" => matches!(
            name,
            "src" | "poster" | "width" | "height" | "controls" | "loop" | "muted" | "preload"
        ),
        "audio" => matches!(name, "src" | "controls" | "loop" | "muted" | "preload"),
        "track" => matches!(name, "src" | "kind" | "srclang" | "label" | "default"),
        "th" => matches!(name, "colspan" | "rowspan" | "scope" | "headers"),
        "td" => matches!(name, "colspan" | "rowspan" | "headers"),
        "col" | "colgroup" => name == "span",
        "time" => name == "datetime",
        "math" => name == "xmlns",
        _ => false,
    }
}

/// Schemes allowed for a URL-carrying attribute on a given tag; None when
/// the attribute doesn't carry a URL (no scheme check).
fn url_schemes_for(tag: &str, name: &str) -> Option<&'static [&'static str]> {
    match (tag, name) {
        ("a", "href") => Some(SAFE_SCHEMES),
        ("img", "src") | ("source", "src") => Some(IMAGE_SCHEMES),
        ("video", "src") | ("audio", "src") | ("track", "src") | ("video", "poster") => {
            Some(SAFE_SCHEMES)
        }
        _ => None,
    }
}

/// Splits a srcset value into candidate URLs, tolerant of commas inside URLs
/// (Cloudinary-style `f_auto,q_auto`): an entry boundary is a comma preceded
/// by a width/density descriptor or followed by something that looks like a
/// new URL. Mirrors `absolutizeSrcset` in content-cleaner.ts.
fn srcset_urls(value: &str) -> Vec<String> {
    fn has_descriptor(entry: &str) -> bool {
        let trimmed = entry.trim_end();
        let Some(last_ws) = trimmed.rfind(|c: char| c.is_whitespace()) else {
            return false;
        };
        let desc = &trimmed[last_ws + 1..];
        if desc.len() < 2 {
            return false;
        }
        let (num, suffix) = desc.split_at(desc.len() - 1);
        matches!(suffix, "w" | "x") && num.chars().all(|c| c.is_ascii_digit() || c == '.')
            && num.chars().any(|c| c.is_ascii_digit())
    }
    fn looks_like_new_entry(s: &str) -> bool {
        s.starts_with("http://")
            || s.starts_with("https://")
            || s.starts_with("data:")
            || s.starts_with("//")
            || s.starts_with('/')
    }
    let mut entries: Vec<String> = Vec::new();
    for raw in value.split(',') {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        match entries.last() {
            None => entries.push(trimmed.to_string()),
            Some(prev) => {
                if has_descriptor(prev) || looks_like_new_entry(trimmed) {
                    entries.push(trimmed.to_string());
                } else {
                    let last = entries.last_mut().unwrap();
                    last.push(',');
                    last.push_str(trimmed);
                }
            }
        }
    }
    entries
        .into_iter()
        .filter_map(|entry| entry.split_whitespace().next().map(str::to_string))
        .collect()
}

/// Iframes survive only as normalized allow-listed embeds: validate/rewrite
/// the src, keep only width/height/title from the source, and force
/// sandbox/allow/loading. Anything unrecognized is removed with its content.
fn handle_iframe(el: &mut Element) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let src = el.get_attribute("src");
    let embed = src.as_deref().and_then(|s| normalize_embed(&decode_attr(s)));
    let Some(embed) = embed else {
        el.remove();
        return Ok(());
    };
    let to_remove: Vec<String> = el
        .attributes()
        .iter()
        .map(|a| a.name())
        .filter(|n| !matches!(n.as_str(), "width" | "height" | "title"))
        .collect();
    for name in to_remove {
        el.remove_attribute(&name);
    }
    el.set_attribute("src", &embed.src)?;
    el.set_attribute("sandbox", embed.sandbox)?;
    el.set_attribute("allow", embed.allow)?;
    el.set_attribute("allowfullscreen", "")?;
    el.set_attribute("loading", "lazy")?;
    Ok(())
}

fn handle_element(el: &mut Element) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let tag = el.tag_name();
    if !tag_allowed(&tag) {
        if DROP_WITH_CONTENT.contains(&tag.as_str()) {
            el.remove();
        } else {
            el.remove_and_keep_content();
        }
        return Ok(());
    }
    if tag == "iframe" {
        return handle_iframe(el);
    }

    let mut to_remove: Vec<String> = Vec::new();
    for attr in el.attributes() {
        let name = attr.name();
        if !attr_allowed(&tag, &name) {
            to_remove.push(name);
            continue;
        }
        if let Some(schemes) = url_schemes_for(&tag, &name) {
            // `is_image_url_allowed` matches `is_url_allowed` for every scheme
            // except `data:`, which it MIME-gates to `image/*`. `data` is only
            // ever in `IMAGE_SCHEMES` (image sinks), so this is a no-op for the
            // http/https/mailto/tel attributes and closes `data:text/html` on
            // `img`/`source` `src`.
            if !is_image_url_allowed(&decode_attr(&attr.value()), schemes) {
                to_remove.push(name);
            }
        } else if name == "srcset" && matches!(tag.as_str(), "img" | "source") {
            let decoded = decode_attr(&attr.value()).into_owned();
            if !srcset_urls(&decoded)
                .iter()
                .all(|u| is_image_url_allowed(u, IMAGE_SCHEMES))
            {
                to_remove.push(name);
            }
        }
    }
    for name in to_remove {
        el.remove_attribute(&name);
    }

    if tag == "a" {
        // External links open in a new tab with a safe rel (anti
        // reverse-tabnabbing). Relative/in-page links are left alone.
        if let Some(href) = el.get_attribute("href") {
            let decoded = decode_attr(&href);
            let normalized = decoded.trim().to_ascii_lowercase();
            if normalized.starts_with("http://")
                || normalized.starts_with("https://")
                || normalized.starts_with("//")
            {
                el.set_attribute("target", "_blank")?;
                el.set_attribute("rel", "noopener noreferrer")?;
            }
        }
    } else if tag == "img" {
        el.set_attribute("loading", "lazy")?;
    }
    Ok(())
}

/// Run the allow-list pass over `html`. Errors (rewriter failure) must be
/// treated as fatal by the caller — there is no partial output to serve.
pub fn sanitize_html_pass(html: &str) -> Result<String, String> {
    let mut output = Vec::with_capacity(html.len());
    let mut rewriter = HtmlRewriter::new(
        Settings {
            element_content_handlers: vec![element!("*", handle_element)],
            document_content_handlers: vec![
                doc_comments!(|c| {
                    c.remove();
                    Ok(())
                }),
                doctype!(|d| {
                    d.remove();
                    Ok(())
                }),
            ],
            ..Settings::new()
        },
        |chunk: &[u8]| output.extend_from_slice(chunk),
    );
    rewriter.write(html.as_bytes()).map_err(|e| e.to_string())?;
    rewriter.end().map_err(|e| e.to_string())?;
    String::from_utf8(output).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sanitize(html: &str) -> String {
        sanitize_html_pass(html).unwrap()
    }

    #[test]
    fn strips_script_with_content_unwraps_unknown() {
        assert_eq!(
            sanitize("<p>ok</p><script>alert(1)</script><custom>kept</custom>"),
            "<p>ok</p>kept"
        );
    }

    #[test]
    fn removes_event_handlers_and_bad_schemes() {
        assert_eq!(
            sanitize(r#"<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">x</a>"#),
            r#"<img src="x" loading="lazy"><a>x</a>"#
        );
    }

    #[test]
    fn entity_encoded_scheme_is_caught() {
        assert_eq!(
            sanitize(r#"<a href="java&#115;cript:alert(1)">x</a>"#),
            "<a>x</a>"
        );
    }

    #[test]
    fn external_links_get_target_and_rel() {
        assert_eq!(
            sanitize(r#"<a href="https://example.com">x</a><a href="/local">y</a>"#),
            r#"<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a><a href="/local">y</a>"#
        );
    }

    #[test]
    fn iframe_embeds_only_for_providers() {
        assert_eq!(
            sanitize(r#"<iframe src="https://evil.com/page"></iframe><p>after</p>"#),
            "<p>after</p>"
        );
        let out = sanitize(
            r#"<iframe width="560" src="https://www.youtube.com/embed/abc123?autoplay=1"></iframe>"#,
        );
        assert!(out.contains(r#"src="https://www.youtube-nocookie.com/embed/abc123""#), "{out}");
        assert!(out.contains(r#"width="560""#));
        assert!(out.contains("sandbox="));
        assert!(!out.contains("autoplay"));
    }

    #[test]
    fn comments_and_doctype_removed() {
        assert_eq!(sanitize("<!DOCTYPE html><!-- hi --><p>x</p>"), "<p>x</p>");
    }

    #[test]
    fn data_uri_images_allowed_but_not_links() {
        assert_eq!(
            sanitize(r#"<img src="data:image/png;base64,AAA="><a href="data:text/html,x">x</a>"#),
            r#"<img src="data:image/png;base64,AAA=" loading="lazy"><a>x</a>"#
        );
    }

    #[test]
    fn mathml_preserved() {
        let math = r#"<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi><msup><mi>y</mi><mn>2</mn></msup></math>"#;
        assert_eq!(sanitize(math), math);
    }

    #[test]
    fn srcset_with_bad_scheme_dropped_entirely() {
        assert_eq!(
            sanitize(r#"<img src="a.png" srcset="javascript:x 1x, b.png 2x">"#),
            r#"<img src="a.png" loading="lazy">"#
        );
        let ok = r#"<img src="a.png" srcset="https://x.com/f_auto,q_auto/a.png 1x, /b.png 2x" loading="lazy">"#;
        assert_eq!(sanitize(ok), ok);
    }

    #[test]
    fn style_content_dropped() {
        assert_eq!(sanitize("<style>p{}</style><p>x</p>"), "<p>x</p>");
    }

    #[test]
    fn rawtext_element_content_is_dropped_not_unwrapped() {
        // Inside a rawtext/RCDATA element the tokenizer reads markup as text,
        // so unwrapping would re-emit it verbatim and the browser would
        // re-parse it as a live element (mXSS). All such non-allow-listed
        // elements must drop their whole subtree.
        for tag in ["title", "xmp", "noembed", "noframes", "noscript", "plaintext", "textarea"] {
            let input = format!("<p>ok</p><{tag}><img src=x onerror=alert(1)></{tag}>");
            let out = sanitize(&input);
            assert!(
                !out.contains("onerror") && !out.contains("<img"),
                "tag {tag}: {out}"
            );
            assert!(out.starts_with("<p>ok</p>"), "tag {tag}: {out}");
        }
    }

    #[test]
    fn img_src_rejects_mailto_tel_but_keeps_data() {
        // img/source src is http/https/data only (parity with the old
        // allowedSchemesByTag) — mailto/tel are not image sources.
        assert_eq!(sanitize(r#"<img src="mailto:x@y.com">"#), r#"<img loading="lazy">"#);
        assert_eq!(
            sanitize(r#"<img src="data:image/png;base64,AAA=">"#),
            r#"<img src="data:image/png;base64,AAA=" loading="lazy">"#
        );
    }

    #[test]
    fn img_src_data_must_be_image_mime() {
        // `data:` is allowed on image sinks only when the MIME type is image/*.
        // `data:image/svg+xml` stays (passive image context); `data:text/html`
        // and other non-image data URLs are dropped from src and srcset.
        assert_eq!(
            sanitize(r#"<img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">"#),
            r#"<img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" loading="lazy">"#
        );
        assert_eq!(
            sanitize(r#"<img src="data:text/html,<script>alert(1)</script>">"#),
            r#"<img loading="lazy">"#
        );
        // A non-image data: candidate drops the whole srcset (all-or-nothing).
        assert_eq!(
            sanitize(r#"<img src="a.png" srcset="data:text/html,x 1x, b.png 2x">"#),
            r#"<img src="a.png" loading="lazy">"#
        );
        let ok = r#"<img srcset="data:image/png;base64,AAA= 1x, /b.png 2x" loading="lazy">"#;
        assert_eq!(sanitize(ok), ok);
    }

    #[test]
    fn data_attributes_kept() {
        assert_eq!(
            sanitize(r#"<p data-para-id="7" class="a" bogus="1">x</p>"#),
            r#"<p data-para-id="7" class="a">x</p>"#
        );
    }

    #[test]
    fn aria_and_role_attributes_kept() {
        // ARIA hooks are inert and required for assistive tech (e.g. footnotes).
        assert_eq!(
            sanitize(
                r#"<ol role="doc-endnotes"><li role="doc-endnote" aria-label="Footnote 1">x</li></ol>"#
            ),
            r#"<ol role="doc-endnotes"><li role="doc-endnote" aria-label="Footnote 1">x</li></ol>"#
        );
    }
}
