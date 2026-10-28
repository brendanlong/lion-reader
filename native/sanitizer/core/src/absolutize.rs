//! Absolutizes relative URLs in `src`, `href`, `poster` and `srcset`
//! (`absolutizeUrls` in `src/server/feed/content-cleaner.ts`), and moves
//! images inlined as `data:` URIs out to storage. Runs on raw feed and article
//! HTML before it's stored, so it isn't part of the sanitizer pipeline, which
//! still runs on everything this outputs.
//!
//! One streaming lol_html pass. Only start tags whose URL actually changes are
//! re-serialized; every other byte passes through untouched. Values are read
//! and written raw (not entity-decoded), the way lol_html does.

use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashSet;
use std::fmt::Write;

use data_url::DataUrl;
use lol_html::html_content::Element;
use lol_html::{element, rewrite_str, HandlerResult, RewriteStrSettings};
use sha2::{Digest, Sha256};
use url::Url;

use crate::urls::decode_attr;

/// A base URL and, optionally, the directory URL that root-relative paths
/// (`/a/b.png`) resolve against instead of the origin root. The root is for
/// sources that serve a document tree under a path prefix and read a leading
/// slash as relative to that tree (a GitHub repo, #1423).
pub struct Bases {
    pub url: String,
    pub root: Option<String>,
}

/// An image [`rewrite_urls`] moved out of the HTML. Its `<img>` now points at
/// the image URL prefix plus `name`, where the caller must store `data`.
pub struct ExtractedImage {
    /// A hash of `data` plus its extension, so the same image gets the same
    /// name each time its entry is processed.
    pub name: String,
    pub content_type: &'static str,
    pub data: Vec<u8>,
}

pub struct Rewritten {
    pub html: String,
    /// Each distinct image once, however many `<img>`s showed it.
    pub images: Vec<ExtractedImage>,
}

/// Rewrites URLs against `document`, except that the embedded-resource
/// attributes (`src`, `poster`, `srcset`) use `media` when given — for sources
/// that serve a document and the files it embeds from different origins. The
/// root travels with its base, so a media base never inherits the document's
/// root (#1422). The first `<base href>` replaces both for the elements after
/// it, and restores origin-root semantics. As in browsers, only the first one
/// counts, and one that doesn't resolve or is `data:`/`javascript:` leaves the
/// bases as they were; so does a fragment-only one, which means "this
/// document".
///
/// Errors only when lol_html rejects the input (e.g. a parsing ambiguity in
/// strict mode); callers fall back to the input.
pub fn absolutize_urls(
    html: &str,
    document: &Bases,
    media: Option<&Bases>,
) -> Result<String, String> {
    rewrite_urls(html, Some(document), media, None).map(|rewritten| rewritten.html)
}

/// [`absolutize_urls`], except that without a `document` base relative URLs
/// stay as written (a `<base href>` included), and given an `image_url_prefix`, each `<img>` whose `src`
/// is a `data:` URI holding a raster image (PNG, JPEG, GIF, WebP or AVIF)
/// points at `{image_url_prefix}{name}` instead, its image returned for the
/// caller to store under that name.
///
/// The type comes from the image's bytes, never its declared type, since
/// storage serves it with that type: an SVG (which would run its scripts from
/// the bucket's origin) or anything else that isn't a raster image stays
/// inline, for the sanitizer to judge on every read. So does an image whose
/// `data:` URI is no longer than its replacement URL (a lazy-loading
/// placeholder pixel): moving it wouldn't shrink the HTML.
pub fn rewrite_urls(
    html: &str,
    document: Option<&Bases>,
    media: Option<&Bases>,
    image_url_prefix: Option<&str>,
) -> Result<Rewritten, String> {
    let page_url = document.and_then(|document| Url::parse(&document.url).ok());
    let base_href_set = document.is_none();
    let document = document.map_or_else(ResolveBase::none, ResolveBase::new);
    let state = RefCell::new(State {
        media: media.map_or_else(|| document.clone(), ResolveBase::new),
        document,
        base_href_set,
        images: Vec::new(),
        image_names: HashSet::new(),
    });

    let settings = RewriteStrSettings {
        element_content_handlers: vec![
            element!("base[href]", |el| {
                let mut state = state.borrow_mut();
                if state.base_href_set {
                    return Ok(());
                }
                state.base_href_set = true;
                let href = el.get_attribute("href").unwrap_or_default();
                let href = href.trim_matches(is_js_whitespace);
                if href.is_empty() || href.starts_with('#') {
                    return Ok(());
                }
                let resolved = Url::options().base_url(page_url.as_ref()).parse(href).ok();
                if let Some(resolved) =
                    resolved.filter(|u| !matches!(u.scheme(), "data" | "javascript"))
                {
                    let base = ResolveBase::plain(resolved);
                    state.document = base.clone();
                    state.media = base;
                }
                Ok(())
            }),
            element!("[src]", |el| {
                if let Some(prefix) = image_url_prefix.filter(|_| el.tag_name() == "img") {
                    let src = el.get_attribute("src").unwrap_or_default();
                    if let Some(stored_src) = extract_image(&src, prefix, &mut state.borrow_mut()) {
                        el.set_attribute("src", &stored_src)?;
                        return Ok(());
                    }
                }
                rewrite(el, "src", |v| resolve_url(v, &state.borrow().media))
            }),
            element!("[href]", |el| {
                // The <base> tag's own href stays as written.
                if el.tag_name() == "base" {
                    return Ok(());
                }
                rewrite(el, "href", |v| resolve_url(v, &state.borrow().document))
            }),
            element!("[poster]", |el| {
                rewrite(el, "poster", |v| resolve_url(v, &state.borrow().media))
            }),
            element!("[srcset]", |el| {
                rewrite(el, "srcset", |v| {
                    Some(Cow::Owned(absolutize_srcset(v, &state.borrow().media)))
                })
            }),
        ],
        ..RewriteStrSettings::new()
    };
    let html = rewrite_str(html, settings).map_err(|e| e.to_string())?;
    Ok(Rewritten {
        html,
        images: state.into_inner().images,
    })
}

/// Hex digits of an image's name: its whole sha256, as `storeEntryImage`
/// (`src/server/services/stored-objects.ts`) names the images it stores.
const IMAGE_HASH_HEX_LEN: usize = 64;

/// The longest name [`extract_image`] gives an image: its hash and extension.
const MAX_IMAGE_NAME_LEN: usize = IMAGE_HASH_HEX_LEN + ".webp".len();

/// Moves an inlined raster image out (see [`rewrite_urls`]), returning the
/// `src` that replaces it.
fn extract_image(src: &str, url_prefix: &str, state: &mut State) -> Option<String> {
    // Checked before decoding anything, so the many short data: URIs cost
    // nothing.
    if src.len() <= url_prefix.len() + MAX_IMAGE_NAME_LEN {
        return None;
    }
    // The value is raw; a browser entity-decodes it once before reading the
    // URL, so `&amp;` in a payload is one byte.
    let decoded = decode_attr(src);
    let trimmed = decoded.trim_matches(is_js_whitespace);
    if !trimmed.get(..5)?.eq_ignore_ascii_case("data:") {
        return None;
    }
    let (data, _) = DataUrl::process(trimmed).ok()?.decode_to_vec().ok()?;
    let (content_type, extension) = sniff_raster_image(&data)?;

    let mut name = String::with_capacity(MAX_IMAGE_NAME_LEN);
    for byte in Sha256::digest(&data) {
        let _ = write!(name, "{byte:02x}");
    }
    name.push_str(extension);

    let stored_src = format!("{url_prefix}{name}");
    if state.image_names.insert(name.clone()) {
        state.images.push(ExtractedImage {
            name,
            content_type,
            data,
        });
    }
    Some(stored_src)
}

/// The content type and extension of a raster image, from its magic bytes.
fn sniff_raster_image(data: &[u8]) -> Option<(&'static str, &'static str)> {
    let brand = data.get(4..12);
    if data.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", ".png"))
    } else if data.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(("image/jpeg", ".jpg"))
    } else if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        Some(("image/gif", ".gif"))
    } else if data.starts_with(b"RIFF") && data.get(8..12) == Some(b"WEBP") {
        Some(("image/webp", ".webp"))
    } else if brand == Some(b"ftypavif") || brand == Some(b"ftypavis") {
        Some(("image/avif", ".avif"))
    } else {
        None
    }
}

struct State {
    document: ResolveBase,
    media: ResolveBase,
    base_href_set: bool,
    images: Vec<ExtractedImage>,
    image_names: HashSet<String>,
}

/// [`Bases`], parsed once. `None`/`Err` mean the URL doesn't parse, so
/// resolving against it fails and the value is left alone.
#[derive(Clone)]
struct ResolveBase {
    url: Option<Url>,
    root: Option<Result<Url, url::ParseError>>,
}

impl ResolveBase {
    fn new(bases: &Bases) -> Self {
        Self {
            url: Url::parse(&bases.url).ok(),
            // A root without a trailing slash is still a directory: relative
            // paths resolve *under* it instead of replacing its last segment.
            root: bases.root.as_ref().map(|root| {
                if root.ends_with('/') {
                    Url::parse(root)
                } else {
                    Url::parse(&format!("{root}/"))
                }
            }),
        }
    }

    fn none() -> Self {
        Self {
            url: None,
            root: None,
        }
    }

    fn plain(url: Url) -> Self {
        Self {
            url: Some(url),
            root: None,
        }
    }
}

fn rewrite(
    el: &mut Element,
    name: &str,
    absolutize: impl FnOnce(&str) -> Option<Cow<'_, str>>,
) -> HandlerResult {
    let Some(value) = el.get_attribute(name) else {
        return Ok(());
    };
    if value.is_empty() {
        return Ok(());
    }
    if let Some(new_value) = absolutize(&value) {
        // Skip no-op writes: `set_attribute` re-serializes the whole tag.
        if *new_value != *value {
            let new_value = new_value.into_owned();
            el.set_attribute(name, &new_value)?;
        }
    }
    Ok(())
}

/// JavaScript's `\s` / `String.prototype.trim` set: Unicode `White_Space`
/// minus U+0085, plus the BOM.
fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

/// Resolves `url` against `base`: the value unchanged when it must stay as
/// written, the absolute URL, or `None` when it doesn't resolve.
fn resolve_url<'a>(url: &'a str, base: &ResolveBase) -> Option<Cow<'a, str>> {
    // The URL parser ignores surrounding whitespace, so classify its view of
    // the value rather than the raw attribute.
    let trimmed = url.trim_matches(is_js_whitespace);

    if ["data:", "javascript:", "vbscript:"]
        .iter()
        .any(|scheme| trimmed.starts_with(scheme))
    {
        return Some(Cow::Borrowed(url));
    }

    // Leave same-document fragments (`#footnote-1`, `#bib.bib19`) relative.
    // Their target is an `id` in this very entry, which survives
    // sanitization, so absolutizing would send the reader off-site — and the
    // sanitizer would then add `target="_blank"` to what should be a scroll
    // (#1425). In a truncated excerpt feed the target may only exist on the
    // source page, so such a link dead-ends there; full-text entries (arXiv
    // citations, footnotes, Markdown tables of contents) are the more common
    // case.
    if trimmed.starts_with('#') {
        return Some(Cow::Borrowed(url));
    }

    // `//host/path` is protocol-relative, not root-relative, so it gets
    // ordinary handling.
    if let Some(root) = &base.root {
        if let Some(path) = trimmed.strip_prefix('/').filter(|p| !p.starts_with('/')) {
            let root = root.as_ref().ok()?;
            return root.join(path).ok().map(|u| Cow::Owned(u.into()));
        }
    }

    let resolved = base.url.as_ref()?.join(url).ok()?;
    Some(Cow::Owned(resolved.into()))
}

/// Whether a srcset entry ends with a descriptor (`1x`, `1.5x`, `480w`) —
/// `/\s\d+(\.\d+)?[wx]\s*$/`.
fn has_descriptor(entry: &str) -> bool {
    let trailing_digits =
        |s: &str| s.len() - s.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    let ends_with_space = |s: &str| s.chars().next_back().is_some_and(is_js_whitespace);

    let Some(number) = entry
        .trim_end_matches(is_js_whitespace)
        .strip_suffix(['w', 'x'])
    else {
        return false;
    };
    let digits = trailing_digits(number);
    if digits == 0 {
        return false;
    }
    let before = &number[..number.len() - digits];
    if ends_with_space(before) {
        return true;
    }
    match before.strip_suffix('.') {
        Some(integer) => {
            let digits = trailing_digits(integer);
            digits > 0 && ends_with_space(&integer[..integer.len() - digits])
        }
        None => false,
    }
}

/// Whether a srcset part starts a new entry rather than continuing a URL that
/// contained a comma: it starts with a scheme we expect or an absolute path.
fn looks_like_new_srcset_entry(part: &str) -> bool {
    ["http://", "https://", "data:", "/"]
        .iter()
        .any(|prefix| part.starts_with(prefix))
}

/// Absolutizes each URL in a srcset (`"a.jpg 1x, b.jpg 2x"`). Commas can
/// appear inside URLs (Cloudinary's `f_auto,q_auto`), so a comma only splits
/// entries after a descriptor or before something that looks like a new URL.
fn absolutize_srcset(srcset: &str, base: &ResolveBase) -> String {
    let mut entries: Vec<String> = Vec::new();
    // Whether the previous entry ends with a descriptor. Its last part decides
    // that (a descriptor can't span a comma), so test each part once rather
    // than re-testing an entry that grows with every rejoined part —
    // quadratic.
    let mut previous_has_descriptor = false;
    for raw in srcset.split(',') {
        let part = raw.trim_matches(is_js_whitespace);
        if part.is_empty() {
            continue;
        }
        match entries.last_mut() {
            Some(last) if !previous_has_descriptor && !looks_like_new_srcset_entry(part) => {
                last.push(',');
                last.push_str(part);
            }
            _ => entries.push(part.to_string()),
        }
        previous_has_descriptor = has_descriptor(part);
    }

    entries
        .iter()
        .map(|entry| {
            let mut words = entry.split(is_js_whitespace).filter(|w| !w.is_empty());
            let url = words.next().unwrap_or_default();
            let descriptor = words.collect::<Vec<_>>().join(" ");
            match resolve_url(url, base) {
                Some(absolute) if descriptor.is_empty() => absolute.into_owned(),
                Some(absolute) => format!("{absolute} {descriptor}"),
                None => entry.clone(),
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    const BASE: &str = "https://example.com/articles/test-article";

    fn bases(url: &str, root: Option<&str>) -> Bases {
        Bases {
            url: url.to_string(),
            root: root.map(str::to_string),
        }
    }

    fn abs(html: &str, base: &str) -> String {
        absolutize_urls(html, &bases(base, None), None).unwrap()
    }

    fn abs_with(html: &str, document: Bases, media: Option<Bases>) -> String {
        absolutize_urls(html, &document, media.as_ref()).unwrap()
    }

    #[test]
    fn resolves_relative_src_href_and_poster() {
        let html = r#"<img src="/images/photo.jpg" alt="Test"><img src="photo.jpg"><a href="/page">x</a><video poster="/images/poster.jpg"></video>"#;
        assert_eq!(
            abs(html, BASE),
            r#"<img src="https://example.com/images/photo.jpg" alt="Test"><img src="https://example.com/articles/photo.jpg"><a href="https://example.com/page">x</a><video poster="https://example.com/images/poster.jpg"></video>"#
        );
    }

    #[test]
    fn leaves_absolute_and_script_like_urls_alone() {
        let html = concat!(
            r#"<img src="https://cdn.example.com/a.png"><a href="https://other.com/">x</a>"#,
            r#"<img src="data:image/png;base64,abc"><a href="javascript:void(0)">y</a>"#,
            r#"<a href=" vbscript:x">z</a>"#,
        );
        assert_eq!(abs(html, BASE), html);
    }

    #[test]
    fn untouched_markup_is_byte_identical() {
        let html = concat!(
            "<!DOCTYPE html><P CLASS=x>a&amp;b<img src='https://cdn.example.com/a.png' ",
            r#"srcset="https://cdn.example.com/b.png 2x"/><a href=rel>x</a></P><!-- c -->"#,
        );
        assert_eq!(
            abs(html, BASE),
            html.replace("href=rel", r#"href="https://example.com/articles/rel""#)
        );
    }

    #[test]
    fn resolves_against_a_directory_or_its_parent() {
        let html = r#"<img src="figures/fig.png">"#;
        assert_eq!(
            abs(html, "https://arxiv.org/html/2601.04480v1/"),
            r#"<img src="https://arxiv.org/html/2601.04480v1/figures/fig.png">"#
        );
        assert_eq!(
            abs(html, "https://arxiv.org/html/2601.04480v1"),
            r#"<img src="https://arxiv.org/html/figures/fig.png">"#
        );
    }

    #[test]
    fn srcset_urls_are_resolved_and_normalized() {
        assert_eq!(
            abs(r#"<img srcset="/s.jpg 1x,/l.jpg   2x">"#, BASE),
            r#"<img srcset="https://example.com/s.jpg 1x, https://example.com/l.jpg 2x">"#
        );
    }

    #[test]
    fn srcset_keeps_commas_inside_urls() {
        let cases = [
            // No descriptor at all.
            (
                "https://res.cloudinary.com/x/f_auto,q_auto/v1/foo/bar",
                "https://res.cloudinary.com/x/f_auto,q_auto/v1/foo/bar",
            ),
            // Descriptors end each entry.
            (
                "https://res.cloudinary.com/x/f_auto,q_auto/a.jpg 1x, https://res.cloudinary.com/x/f_auto,q_auto/b.jpg 1.5x",
                "https://res.cloudinary.com/x/f_auto,q_auto/a.jpg 1x, https://res.cloudinary.com/x/f_auto,q_auto/b.jpg 1.5x",
            ),
            // An absolute path starts a new entry even without a descriptor before it.
            (
                "https://res.cloudinary.com/x/f_auto,q_auto/a.jpg, /fallback.jpg 480w",
                "https://res.cloudinary.com/x/f_auto,q_auto/a.jpg, https://example.com/fallback.jpg 480w",
            ),
        ];
        for (srcset, expected) in cases {
            assert_eq!(
                abs(&format!(r#"<img srcset="{srcset}">"#), BASE),
                format!(r#"<img srcset="{expected}">"#),
                "{srcset}"
            );
        }
    }

    #[test]
    fn descriptor_detection_matches_the_srcset_grammar() {
        for entry in ["a 1x", "a 480w", "a 1.5x", "a\t2x  "] {
            assert!(has_descriptor(entry), "{entry}");
        }
        for entry in [
            "a1x",
            "a .5x",
            "a 1.x",
            "a 1.2.3x",
            "a 2",
            "x",
            "a x",
            "a\u{85}2x",
        ] {
            assert!(!has_descriptor(entry), "{entry}");
        }
    }

    #[test]
    fn srcset_stays_linear() {
        // Re-testing each growing entry, and an unanchored leading `\s+` in
        // the JS version, made these quadratic (seconds).
        for srcset in ["a,".repeat(100_000), format!("a{}a,b", " ".repeat(50_000))] {
            let started = Instant::now();
            abs(&format!(r#"<img srcset="{srcset}">"#), BASE);
            assert!(started.elapsed() < Duration::from_millis(500));
        }
    }

    #[test]
    fn first_base_href_governs_everything_after_it() {
        let html = concat!(
            r#"<img src="before.jpg"><base href="https://cdn.example.com/assets/">"#,
            r#"<base href="https://second.example.com/"><img src="photo.jpg">"#,
            r#"<a href="page.html">x</a><video poster="p.jpg"></video><img srcset="s.jpg 1x">"#,
        );
        assert_eq!(
            abs(html, "https://example.com/page"),
            concat!(
                r#"<img src="https://example.com/before.jpg"><base href="https://cdn.example.com/assets/">"#,
                r#"<base href="https://second.example.com/"><img src="https://cdn.example.com/assets/photo.jpg">"#,
                r#"<a href="https://cdn.example.com/assets/page.html">x</a><video poster="https://cdn.example.com/assets/p.jpg"></video><img srcset="https://cdn.example.com/assets/s.jpg 1x">"#,
            )
        );
    }

    #[test]
    fn relative_base_href_resolves_against_the_page_url() {
        assert_eq!(
            abs(
                r#"<base href="/assets/"><img src="photo.jpg">"#,
                "https://example.com/page"
            ),
            r#"<base href="/assets/"><img src="https://example.com/assets/photo.jpg">"#
        );
    }

    #[test]
    fn a_first_base_href_that_cannot_be_a_base_still_wins() {
        for href in [
            "#x",
            " #x",
            "",
            "javascript:void(0)",
            "data:text/html,x",
            "http://[bad",
        ] {
            let html = format!(r#"<base href="{href}"><base href="/other/"><img src="a.png">"#);
            assert_eq!(
                abs(&html, "https://example.com/docs/page.html"),
                html.replace("a.png", "https://example.com/docs/a.png"),
                "{href:?}"
            );
        }
    }

    #[test]
    fn same_document_fragments_stay_relative() {
        // #1425: arXiv citations, LessWrong footnotes and Markdown TOCs point
        // at ids in the same entry.
        let html =
            r##"<a href="#bib.bib19">1</a><a href="#">top</a><a href="/other#section">x</a>"##;
        assert_eq!(
            abs(html, BASE),
            r##"<a href="#bib.bib19">1</a><a href="#">top</a><a href="https://example.com/other#section">x</a>"##
        );
    }

    #[test]
    fn media_base_applies_to_embedded_resources_only() {
        let html = r#"<img src="i/p.jpg"><a href="o.html">x</a><video poster="i/v.jpg"></video><img srcset="i/s.jpg 1x">"#;
        assert_eq!(
            abs_with(
                html,
                bases("https://example.com/docs/page.html", None),
                Some(bases("https://cdn.example.com/docs/page.html", None)),
            ),
            r#"<img src="https://cdn.example.com/docs/i/p.jpg"><a href="https://example.com/docs/o.html">x</a><video poster="https://cdn.example.com/docs/i/v.jpg"></video><img srcset="https://cdn.example.com/docs/i/s.jpg 1x">"#
        );
    }

    #[test]
    fn base_href_overrides_the_media_base() {
        assert_eq!(
            abs_with(
                r#"<base href="https://base.example.com/"><img src="photo.jpg">"#,
                bases("https://example.com/page", None),
                Some(bases("https://cdn.example.com/", None)),
            ),
            r#"<base href="https://base.example.com/"><img src="https://base.example.com/photo.jpg">"#
        );
    }

    #[test]
    fn root_relative_paths_resolve_against_the_root() {
        let html = r#"<img src="/i/p.jpg"><a href="/d/o.md">x</a><img srcset="/i/s.jpg 1x"><img src="i/rel.jpg"><a href="o.md">y</a>"#;
        assert_eq!(
            abs_with(
                html,
                bases(
                    "https://example.com/tree/main/docs/page.md",
                    Some("https://example.com/tree/main/")
                ),
                Some(bases(
                    "https://cdn.example.com/main/docs/page.md",
                    Some("https://cdn.example.com/main")
                )),
            ),
            concat!(
                r#"<img src="https://cdn.example.com/main/i/p.jpg"><a href="https://example.com/tree/main/d/o.md">x</a>"#,
                r#"<img srcset="https://cdn.example.com/main/i/s.jpg 1x"><img src="https://cdn.example.com/main/docs/i/rel.jpg">"#,
                r#"<a href="https://example.com/tree/main/docs/o.md">y</a>"#,
            )
        );
    }

    #[test]
    fn root_follows_whitespace_and_skips_protocol_relative_urls() {
        let document = || {
            bases(
                "https://example.com/tree/main/page.md",
                Some("https://example.com/tree/main/"),
            )
        };
        assert_eq!(
            abs_with(
                r#"<img src="  /i/p.jpg"><img src="//cdn.other.com/p.jpg">"#,
                document(),
                None
            ),
            r#"<img src="https://example.com/tree/main/i/p.jpg"><img src="https://cdn.other.com/p.jpg">"#
        );
    }

    #[test]
    fn media_base_never_inherits_the_document_root() {
        // #1422: without its own root, a cross-origin media base must not fall
        // back to the document's, or images land on the document origin.
        assert_eq!(
            abs_with(
                r#"<img src="/i/p.jpg">"#,
                bases(
                    "https://example.com/tree/main/page.md",
                    Some("https://example.com/tree/main/")
                ),
                Some(bases("https://cdn.example.com/main/page.md", None)),
            ),
            r#"<img src="https://cdn.example.com/i/p.jpg">"#
        );
    }

    #[test]
    fn base_href_restores_origin_root_semantics() {
        assert_eq!(
            abs_with(
                r#"<base href="https://base.example.com/docs/"><img src="/i/p.jpg">"#,
                bases(
                    "https://example.com/tree/main/page.md",
                    Some("https://example.com/tree/main/")
                ),
                None,
            ),
            r#"<base href="https://base.example.com/docs/"><img src="https://base.example.com/i/p.jpg">"#
        );
    }

    #[test]
    fn unparseable_bases_leave_values_alone() {
        let html = r#"<img src="/image.jpg"><a href="https://ok.example.com/">x</a>"#;
        assert_eq!(abs(html, "not-a-valid-url"), html);
    }

    const PREFIX: &str = "https://bucket.example.com/feeds/f/e/";

    /// A PNG's signature plus `filler` bytes: enough for the sniffer, and
    /// long enough that its data: URI outgrows its replacement.
    fn png(filler: u8) -> Vec<u8> {
        let mut data = b"\x89PNG\r\n\x1a\n".to_vec();
        data.extend([filler; 64]);
        data
    }

    fn data_uri(declared_type: &str, data: &[u8]) -> String {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
        format!("data:{declared_type};base64,{encoded}")
    }

    fn extract(html: &str, document: Option<&Bases>) -> Rewritten {
        rewrite_urls(html, document, None, Some(PREFIX)).unwrap()
    }

    fn image_src(image: &ExtractedImage) -> String {
        format!("{PREFIX}{}", image.name)
    }

    #[test]
    fn moves_inlined_images_out_once_each() {
        let (a, b) = (png(1), png(2));
        let html = format!(
            r#"<p><img alt="a" src="{}"><img src="{}"><img src=" {} "></p>"#,
            data_uri("image/png", &a),
            data_uri("image/png", &b),
            data_uri("image/png", &a),
        );
        let rewritten = extract(&html, None);
        assert_eq!(rewritten.images.len(), 2);
        let (first, second) = (&rewritten.images[0], &rewritten.images[1]);
        assert_eq!((first.data.clone(), first.content_type), (a, "image/png"));
        assert_eq!(second.data, b);
        assert!(first.name.ends_with(".png") && first.name != second.name);
        assert_eq!(
            rewritten.html,
            format!(
                r#"<p><img alt="a" src="{}"><img src="{}"><img src="{}"></p>"#,
                image_src(first),
                image_src(second),
                image_src(first),
            )
        );
    }

    #[test]
    fn decodes_entities_in_the_attribute_once() {
        let data = png(b'&');
        // Percent-encoded, with `&` written as `&amp;`.
        let percent: String = data.iter().map(|b| format!("%{b:02X}")).collect();
        let entity_percent = format!("data:image/png,{}", percent.replace("%26", "&amp;"));
        // Base64 with `+` and `/` as character references.
        let mut base64_data = png(0xfb);
        base64_data.extend([0xff; 8]);
        let entity_base64 = data_uri("image/png", &base64_data)
            .replace('+', "&#43;")
            .replace('/', "&#47;");
        assert!(entity_base64.contains("&#"));
        for (src, expected) in [(entity_percent, data), (entity_base64, base64_data)] {
            let rewritten = extract(&format!(r#"<img src="{src}">"#), None);
            assert_eq!(rewritten.images.len(), 1);
            assert_eq!(rewritten.images[0].data, expected);
        }
    }

    #[test]
    fn types_an_image_by_its_bytes() {
        let mut jpeg = vec![0xff, 0xd8, 0xff];
        jpeg.extend([0; 64]);
        let mut gif = b"GIF89a".to_vec();
        gif.extend([0; 64]);
        let mut webp = b"RIFF\0\0\0\0WEBP".to_vec();
        webp.extend([0; 64]);
        let mut avif = b"\0\0\0\x1cftypavif".to_vec();
        avif.extend([0; 64]);
        for (data, content_type, extension) in [
            (jpeg, "image/jpeg", ".jpg"),
            (gif, "image/gif", ".gif"),
            (webp, "image/webp", ".webp"),
            (avif, "image/avif", ".avif"),
            (png(0), "image/png", ".png"),
        ] {
            // Declared as SVG: the bytes decide.
            let html = format!(r#"<img src="{}">"#, data_uri("image/svg+xml", &data));
            let image = &extract(&html, None).images[0];
            assert_eq!(image.content_type, content_type);
            assert!(image.name.ends_with(extension));
        }
    }

    #[test]
    fn keeps_what_it_cannot_serve_as_an_image_inline() {
        let svg = format!("<svg>{}</svg>", " ".repeat(200));
        let html_page = format!("<script>alert(1)</script>{}", " ".repeat(200));
        let placeholder_gif =
            "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        let html = format!(
            concat!(
                r#"<img src="{}"><img src="{}"><img src="{}">"#,
                r#"<img src="data:image/png;base64,%%%{}"><iframe src="{}"></iframe>"#,
                r#"<img src="https://cdn.example.com/a.png">"#,
            ),
            data_uri("image/svg+xml", svg.as_bytes()),
            data_uri("image/png", html_page.as_bytes()),
            placeholder_gif,
            "A".repeat(200),
            data_uri("image/png", &png(1)),
        );
        let rewritten = extract(&html, None);
        assert!(rewritten.images.is_empty());
        assert_eq!(rewritten.html, html);
    }

    #[test]
    fn absolutizes_while_extracting_only_with_a_base() {
        let html = format!(
            r#"<base href="https://other.example.com/"><img src="{}"><a href="/page">x</a>"#,
            data_uri("image/png", &png(1))
        );
        let without_base = extract(&html, None);
        assert!(without_base.html.ends_with(r#"<a href="/page">x</a>"#));
        let with_base = extract(&html, Some(&bases(BASE, None)));
        assert!(with_base
            .html
            .ends_with(r#"<a href="https://other.example.com/page">x</a>"#));
        assert_eq!(with_base.images.len(), 1);
    }

    #[test]
    fn extracts_nothing_without_a_prefix() {
        let html = format!(r#"<img src="{}">"#, data_uri("image/png", &png(1)));
        let rewritten = rewrite_urls(&html, None, None, None).unwrap();
        assert!(rewritten.images.is_empty());
        assert_eq!(rewritten.html, html);
    }

    #[test]
    fn extraction_stays_linear() {
        // Distinct images, so the name set grows with the input.
        let image_count = 20_000;
        let html: String = (0..image_count)
            .map(|i: u32| {
                let mut data = png(0);
                data.extend(i.to_le_bytes());
                format!(r#"<img src="{}">"#, data_uri("image/png", &data))
            })
            .collect();
        let started = Instant::now();
        assert_eq!(extract(&html, None).images.len(), image_count as usize);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn rejected_input_is_an_error() {
        assert!(absolutize_urls(
            r#"<select><xmp><img src="a.png"></xmp></select>"#,
            &bases(BASE, None),
            None
        )
        .is_err());
    }
}
