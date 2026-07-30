//! Locate top-level `<target>…</target>` element byte ranges in an HTML
//! string without building a DOM.
//!
//! This replaces the htmlparser2 "locating passes" of the TypeScript
//! implementation (`convertMathJaxChtmlToMathml`, `extractInlineSvg`): a
//! lightweight, spec-shaped tokenizer walk that understands comments, bogus
//! comments/doctypes, quoted attribute values, self-closing tags, and
//! raw-text element content (`<script>`/`<style>`/… swallow markup until
//! their matching close tag), and reports the byte range of each top-level
//! occurrence of the target element with same-name depth tracking.
//!
//! The low-level pieces of that walk (`tag_name_end`, `scan_to_tag_end`,
//! `skip_raw_text`, `RAW_TEXT_ELEMENTS`) are shared with `sanitize.rs`'s
//! disallowed-end-tag pass, which is a second walk of the same shape — keep
//! them here so the two agree on what a tag is.
//!
//! The scanner is intentionally *not* a full tree builder. Its failure mode
//! on adversarial input is locating a wrong range — which downstream code
//! guards by requiring the substring to actually parse to the target element
//! (else it is spliced through verbatim) — and everything it produces is
//! still run through the sanitizer afterwards, so a mislocated range can
//! cause content mangling but never unsanitized output.

/// Elements whose content the HTML tokenizer treats as raw text (or RCDATA):
/// everything until the matching case-insensitive close tag is character
/// data, so the scanner must not interpret tags inside them. `noscript` is
/// included because browsers with scripting enabled treat its content as raw
/// text. This applies in the HTML namespace only — inside `<svg>`/`<math>`
/// foreign content the tokenizer never switches to raw text, hence the
/// `rawtext` flag on [`find_top_level_ranges`].
pub(crate) const RAW_TEXT_ELEMENTS: &[&str] = &[
    "script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript",
];

/// How to treat a target element that never sees its explicit end tag.
#[derive(Clone, Copy, PartialEq)]
pub enum Recovery {
    /// The unclosed element extends to the end of input and is consumed
    /// whole (matches the old htmlparser2 EOF-implied close for `<svg>`).
    ToEof,
    /// The unclosed element's parseable extent runs to the end of input, but
    /// everything past the last explicit close of one of the tracked inner
    /// tags is *recovered*: the caller splices `[recover_from..end]` back
    /// verbatim, because it is real article content the element wrongly
    /// absorbed (matches the TS `mathEnd` recovery for `<mjx-container>`).
    AtLastInnerClose,
}

/// One located top-level target element.
pub struct ElementRange {
    /// Offset of the `<` of the opening tag.
    pub start: usize,
    /// Just past the `>` of the opening tag.
    pub content_start: usize,
    /// Just past the range's final byte: past the `>` of the explicit close
    /// tag, or the end of input for an unclosed element.
    pub end: usize,
    /// Where recovered content begins for an unclosed element (see
    /// [`Recovery::AtLastInnerClose`]); equals `end` when nothing is
    /// recovered (explicit close, or [`Recovery::ToEof`]).
    pub recover_from: usize,
    /// Whether the element was closed by an explicit end tag (including a
    /// self-closing open tag).
    pub explicit_close: bool,
}

struct Partial {
    start: usize,
    content_start: usize,
    /// Just past the `>` of the last explicit close of a tracked inner tag
    /// (see [`Recovery::AtLastInnerClose`]); `content_start` until one closes.
    inner_close_end: usize,
}

pub(crate) fn find_bytes(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if from >= haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

pub(crate) fn find_byte(haystack: &[u8], from: usize, needle: u8) -> Option<usize> {
    haystack[from.min(haystack.len())..]
        .iter()
        .position(|&b| b == needle)
        .map(|p| p + from)
}

/// Case-insensitive search for `</name` starting at `from`; returns the
/// offset just past the `>` that ends that close tag (or input length).
pub(crate) fn skip_raw_text(bytes: &[u8], from: usize, name: &str) -> usize {
    let mut i = from;
    let name_bytes = name.as_bytes();
    while i < bytes.len() {
        let Some(lt) = find_bytes(bytes, i, b"</") else {
            return bytes.len();
        };
        let name_start = lt + 2;
        let name_end = name_start + name_bytes.len();
        if name_end <= bytes.len()
            && bytes[name_start..name_end].eq_ignore_ascii_case(name_bytes)
            && (name_end == bytes.len()
                || matches!(bytes[name_end], b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r' | b'\x0c'))
        {
            return find_byte(bytes, name_end, b'>').map(|p| p + 1).unwrap_or(bytes.len());
        }
        i = lt + 2;
    }
    bytes.len()
}

/// Reads a (lowercased) tag name starting at `i`; returns (name, index past it).
fn read_tag_name(bytes: &[u8], i: usize) -> (String, usize) {
    let end = tag_name_end(bytes, i);
    (
        String::from_utf8_lossy(&bytes[i..end]).to_ascii_lowercase(),
        end,
    )
}

/// Index just past the tag name starting at `i`. The allocation-free half of
/// [`read_tag_name`], for walks that only need to compare the name.
pub(crate) fn tag_name_end(bytes: &[u8], i: usize) -> usize {
    let mut end = i;
    while end < bytes.len() {
        match bytes[end] {
            b'>' | b'/' | b' ' | b'\t' | b'\n' | b'\r' | b'\x0c' => break,
            _ => end += 1,
        }
    }
    end
}

/// Whitespace that separates a tag's parts (the tokenizer's definition).
pub(crate) fn is_tag_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | b'\x0c')
}

/// The tokenizer states a tag passes through after its name. Only what decides
/// where the tag *ends* is modelled — names and values are skipped, not captured.
#[derive(Clone, Copy)]
enum TagScan {
    BeforeName,
    Name,
    AfterName,
    BeforeValue,
    Quoted(u8),
    Unquoted,
    AfterQuotedValue,
    SelfClosing,
}

/// Scans from just past a tag name to the `>` that ends the tag. Returns (index
/// past `>`, self_closing); an unterminated tag consumes the rest of the input,
/// matching the tokenizer, which drops such a token at EOF.
///
/// The states are load-bearing rather than pedantry: **a quote only opens an
/// attribute value out of _before-attribute-value_ state**, i.e. right after an
/// `=`. A quote anywhere else — `</p " a="x><img src=x onerror=alert(1)>">` — is
/// a parse error that becomes part of the attribute *name*, so treating every
/// quote as a delimiter desynchronizes: the scan pairs the stray quote with the
/// real value's opening quote and then ends the tag at a `>` **inside** that
/// value. That was an XSS bypass while `sanitize.rs` used this to decide which
/// bytes an end tag occupies (issue #1455), and it mislocates MathJax/SVG ranges
/// here.
pub(crate) fn scan_to_tag_end(bytes: &[u8], mut i: usize) -> (usize, bool) {
    let mut state = TagScan::BeforeName;
    while i < bytes.len() {
        let b = bytes[i];
        i += 1;
        state = match state {
            // `/` and `>` are both reconsumed in after-attribute-name, so these
            // two states differ only in what `=` means: a new attribute named
            // `=` before a name, the start of a value after one.
            TagScan::BeforeName | TagScan::Name | TagScan::AfterName => match b {
                b'>' => return (i, false),
                b'/' => TagScan::SelfClosing,
                b'=' if matches!(state, TagScan::Name | TagScan::AfterName) => TagScan::BeforeValue,
                _ if is_tag_ws(b) => match state {
                    TagScan::BeforeName => TagScan::BeforeName,
                    _ => TagScan::AfterName,
                },
                _ => TagScan::Name,
            },
            TagScan::BeforeValue => match b {
                // Parse error (missing attribute value), but it still ends the tag.
                b'>' => return (i, false),
                b'"' | b'\'' => TagScan::Quoted(b),
                _ if is_tag_ws(b) => TagScan::BeforeValue,
                _ => TagScan::Unquoted,
            },
            TagScan::Quoted(quote) if b == quote => TagScan::AfterQuotedValue,
            TagScan::Quoted(quote) => TagScan::Quoted(quote),
            TagScan::Unquoted => match b {
                b'>' => return (i, false),
                _ if is_tag_ws(b) => TagScan::BeforeName,
                _ => TagScan::Unquoted,
            },
            // Both of these reconsume anything unexpected in before-attribute-name,
            // which starts an attribute name on it.
            TagScan::AfterQuotedValue | TagScan::SelfClosing => match b {
                b'>' => return (i, matches!(state, TagScan::SelfClosing)),
                b'/' => TagScan::SelfClosing,
                _ if is_tag_ws(b) => TagScan::BeforeName,
                _ => TagScan::Name,
            },
        };
    }
    (bytes.len(), false)
}

/// Find the byte ranges of every top-level `<target>` element in `html`.
///
/// * `inner_close_tracks` — tag names whose explicit close positions are
///   tracked for [`Recovery::AtLastInnerClose`].
/// * `rawtext` — whether raw-text element content applies while *inside* the
///   target (true for HTML-context targets like `mjx-container`, false for
///   `svg`, where foreign-content parsing keeps `<style>` etc. as markup).
///   Raw-text handling always applies outside the target.
pub fn find_top_level_ranges(
    html: &str,
    target: &str,
    inner_close_tracks: &[&str],
    rawtext_inside: bool,
    recovery: Recovery,
) -> Vec<ElementRange> {
    let mut ranges = Vec::new();
    let bytes = html.as_bytes();
    let mut i = 0usize;
    let mut depth = 0usize;
    let mut current: Option<Partial> = None;

    while i < bytes.len() {
        if bytes[i] != b'<' {
            i += 1;
            continue;
        }
        if bytes[i..].starts_with(b"<!--") {
            i = find_bytes(bytes, i + 4, b"-->").map(|p| p + 3).unwrap_or(bytes.len());
            continue;
        }
        if i + 1 < bytes.len() && (bytes[i + 1] == b'!' || bytes[i + 1] == b'?') {
            // Bogus comment / doctype: ends at the first `>`.
            i = find_byte(bytes, i + 1, b'>').map(|p| p + 1).unwrap_or(bytes.len());
            continue;
        }
        if i + 1 < bytes.len() && bytes[i + 1] == b'/' {
            if !(i + 2 < bytes.len() && bytes[i + 2].is_ascii_alphabetic()) {
                // `</>` or `</ …`: bogus comment per spec, ends at first `>`.
                i = find_byte(bytes, i + 2, b'>').map(|p| p + 1).unwrap_or(bytes.len());
                continue;
            }
            let (name, after) = read_tag_name(bytes, i + 2);
            let close_end = find_byte(bytes, after, b'>').map(|p| p + 1).unwrap_or(bytes.len());
            if depth > 0 {
                if name == target {
                    depth -= 1;
                    if depth == 0 {
                        let p = current.take().expect("depth > 0 implies a current range");
                        ranges.push(ElementRange {
                            start: p.start,
                            content_start: p.content_start,
                            end: close_end,
                            recover_from: close_end,
                            explicit_close: true,
                        });
                    }
                } else if inner_close_tracks.contains(&name.as_str()) {
                    if let Some(p) = current.as_mut() {
                        p.inner_close_end = close_end;
                    }
                }
            }
            i = close_end;
            continue;
        }
        if !(i + 1 < bytes.len() && bytes[i + 1].is_ascii_alphabetic()) {
            // A lone `<` in text.
            i += 1;
            continue;
        }
        let (name, after_name) = read_tag_name(bytes, i + 1);
        let (tag_end, self_closing) = scan_to_tag_end(bytes, after_name);
        if name == target {
            if depth == 0 {
                if self_closing {
                    ranges.push(ElementRange {
                        start: i,
                        content_start: tag_end,
                        end: tag_end,
                        recover_from: tag_end,
                        explicit_close: true,
                    });
                } else {
                    current = Some(Partial {
                        start: i,
                        content_start: tag_end,
                        inner_close_end: tag_end,
                    });
                    depth = 1;
                }
            } else if !self_closing {
                depth += 1;
            }
        } else if !self_closing
            && (depth == 0 || rawtext_inside)
            && RAW_TEXT_ELEMENTS.contains(&name.as_str())
        {
            i = skip_raw_text(bytes, tag_end, &name);
            continue;
        }
        i = tag_end;
    }

    // EOF with the target still open: the element's parseable extent runs to
    // the end of input; `recover_from` marks where absorbed article content
    // begins (everything past the last explicit tracked-inner close), which
    // the caller splices back verbatim under Recovery::AtLastInnerClose.
    if let Some(p) = current {
        ranges.push(ElementRange {
            start: p.start,
            content_start: p.content_start,
            end: bytes.len(),
            recover_from: match recovery {
                Recovery::ToEof => bytes.len(),
                Recovery::AtLastInnerClose => p.inner_close_end,
            },
            explicit_close: false,
        });
    }
    ranges
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ranges(html: &str, target: &str) -> Vec<(usize, usize, bool)> {
        find_top_level_ranges(html, target, &["mjx-math"], true, Recovery::AtLastInnerClose)
            .into_iter()
            .map(|r| (r.start, r.end, r.explicit_close))
            .collect()
    }

    #[test]
    fn finds_simple_range() {
        let html = "a<mjx-container>x</mjx-container>b";
        assert_eq!(ranges(html, "mjx-container"), vec![(1, 33, true)]);
    }

    #[test]
    fn tracks_nesting_depth() {
        let html = "<mjx-container><mjx-container>x</mjx-container></mjx-container>tail";
        let r = ranges(html, "mjx-container");
        assert_eq!(r.len(), 1);
        assert_eq!(&html[r[0].0..r[0].1], "<mjx-container><mjx-container>x</mjx-container></mjx-container>");
    }

    #[test]
    fn skips_comments_and_rawtext() {
        let html = "<!-- <mjx-container> --><script>var a = '<mjx-container>';</script><p>hi</p>";
        assert!(ranges(html, "mjx-container").is_empty());
    }

    #[test]
    fn attribute_values_with_gt_do_not_end_tag() {
        let html = r#"<mjx-container data-x="a>b">x</mjx-container>"#;
        let r = ranges(html, "mjx-container");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].2, true);
        assert_eq!(&html[r[0].0..r[0].1], html);
    }

    #[test]
    fn unclosed_parses_to_eof_and_recovers_after_inner_close() {
        // An unclosed container's parseable extent runs to EOF; everything
        // past the last explicit tracked close is recovered (spliced back
        // verbatim by the caller).
        let html = "<mjx-container><mjx-math>x</mjx-math><p>article continues</p>";
        let r = find_top_level_ranges(
            html,
            "mjx-container",
            &["mjx-math"],
            true,
            Recovery::AtLastInnerClose,
        );
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].end, html.len());
        assert!(!r[0].explicit_close);
        assert_eq!(
            &html[r[0].recover_from..r[0].end],
            "<p>article continues</p>"
        );
    }

    #[test]
    fn unclosed_with_no_tracked_close_recovers_everything() {
        // No tracked inner tag ever closed, so recovery starts right past
        // the opening tag: the whole absorbed body is spliced back verbatim.
        let html = "<mjx-container>broken<p>x</p>";
        let r = find_top_level_ranges(
            html,
            "mjx-container",
            &["mjx-math"],
            true,
            Recovery::AtLastInnerClose,
        );
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].recover_from, r[0].content_start);
        assert_eq!(r[0].end, html.len());
    }

    #[test]
    fn unclosed_svg_extends_to_eof() {
        let html = "a<svg><circle>";
        let r = find_top_level_ranges(html, "svg", &[], false, Recovery::ToEof);
        assert_eq!(r.len(), 1);
        assert_eq!((r[0].start, r[0].end, r[0].explicit_close), (1, html.len(), false));
    }

    #[test]
    fn self_closing_target() {
        let html = "a<svg/>b<svg>x</svg>";
        let r = find_top_level_ranges(html, "svg", &[], false, Recovery::ToEof);
        assert_eq!(r.len(), 2);
        assert_eq!(&html[r[0].start..r[0].end], "<svg/>");
        assert_eq!(&html[r[1].start..r[1].end], "<svg>x</svg>");
    }

    #[test]
    fn rawtext_disabled_inside_svg() {
        // Inside <svg>, <style> is foreign content (not raw text), so the
        // </svg> after it must close the element.
        let html = "<svg><style>a</svg><p>rest</p>";
        let r = find_top_level_ranges(html, "svg", &[], false, Recovery::ToEof);
        assert_eq!(r.len(), 1);
        assert_eq!(&html[r[0].start..r[0].end], "<svg><style>a</svg>");
    }

    #[test]
    fn a_quote_only_delimits_a_value_after_an_equals() {
        // A quote in attribute-*name* position is a parse error that becomes part
        // of the name, so it must not be paired with the next quote — which is
        // the real value's opening one. Getting this wrong ends the tag inside
        // that value and exposes its contents as markup (issue #1455).
        for (html, expected) in [
            // The stray quote before `a=` must not swallow `" a="`.
            (r#"<x " a="y>z">t"#, r#"<x " a="y>z">"#),
            // Unbalanced quotes in name position never open a value at all.
            (r#"<x it's>t"#, "<x it's>"),
            (r#"<x a=y"z>t"#, r#"<x a=y"z>"#),
            // A second quote right after a quoted value starts a new name.
            (r#"<x a="1" "b>t"#, r#"<x a="1" "b>"#),
            // Values that really are quoted still hide a `>`.
            (r#"<x a="p>q">t"#, r#"<x a="p>q">"#),
            (r#"<x a = 'p>q'>t"#, r#"<x a = 'p>q'>"#),
        ] {
            let (end, _) = scan_to_tag_end(html.as_bytes(), tag_name_end(html.as_bytes(), 1));
            assert_eq!(&html[..end], expected, "{html}");
        }
    }

    #[test]
    fn self_closing_only_when_the_slash_ends_the_tag() {
        for (html, self_closing) in [
            ("<x/>", true),
            ("<x a=1 />", true),
            ("<x/ >", false),
            ("<x>", false),
            // A `/` inside an unquoted value belongs to the value.
            ("<x a=b/c>", false),
            ("<x a='b/'>", false),
        ] {
            let (_, got) = scan_to_tag_end(html.as_bytes(), tag_name_end(html.as_bytes(), 1));
            assert_eq!(got, self_closing, "{html}");
        }
    }

    #[test]
    fn case_insensitive_tags() {
        let html = "<SVG viewBox=\"0 0 1 1\">x</SvG>";
        let r = find_top_level_ranges(html, "svg", &[], false, Recovery::ToEof);
        assert_eq!(r.len(), 1);
        assert!(r[0].explicit_close);
    }
}
