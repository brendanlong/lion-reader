//! Namespacing of entry-content `id`s.
//!
//! Entry HTML is rendered into the app's own DOM via `dangerouslySetInnerHTML`,
//! so an `id` from a feed lands in the same document as our UI's ids. Since
//! `getElementById`/`aria-labelledby`/`<label for>` all resolve to the *first*
//! match in document order, a feed carrying `id="url"` can silently steal the
//! association from our own `id="url"` form field. Every surviving id therefore
//! gets a fixed [`ID_PREFIX`], which no app id uses.
//!
//! A prefix, not a random nonce: sanitization is a pure `html -> html` function
//! run on every read, and a nonce would make the same entry serve different
//! bytes each time (no ETag, untestable). Uniqueness across *entries* buys
//! nothing today because only one entry body is in the DOM at a time.
//!
//! The prefix contains a `-`, so `window["uc-foo"]` is not identifier-shaped and
//! cannot shadow a bare variable reference — mild DOM-clobbering hardening.
//!
//! Rewriting an id is only safe if every *reference* to it is rewritten in the
//! same pass, or in-page links and SVG paint references break. The reference
//! surface is exactly what the allow-lists keep:
//!
//! - HTML: `a[href="#…"]`, `a[name]` (legacy anchor), `th`/`td` `headers`, and
//!   the ARIA idref attributes ([`ARIA_IDREF_ATTRS`]).
//! - SVG: `href`/`xlink:href` fragment refs, and `url(#id)` funcIRIs in the
//!   paint/clip/mask/filter attributes ([`SVG_FUNC_IRI_ATTRS`]).
//!
//! Deliberately *not* covered, because the allow-lists make them unreachable:
//! `style` attributes and `<style>` blocks (no CSS `#id` selectors),
//! `label[for]`, `usemap`/`<map name>`, `input[list]`, and SVG `begin`/`end`
//! event refs (no animation elements are allowed). Filter primitives' `in`,
//! `in2` and `result` are *not* document ids — they name values inside one
//! filter — so they must keep their original values.

/// Prefix applied to every entry-content id and idref. "uc" = user content.
pub const ID_PREFIX: &str = "uc-";

/// ARIA attributes whose value is one or more space-separated id references.
/// The rest of `aria-*` is inert text/booleans and passes through untouched.
pub const ARIA_IDREF_ATTRS: &[&str] = &[
    "aria-activedescendant",
    "aria-controls",
    "aria-describedby",
    "aria-details",
    "aria-errormessage",
    "aria-flowto",
    "aria-labelledby",
    "aria-owns",
];

/// SVG presentation attributes that can hold a `url(#id)` funcIRI. Gradients,
/// clip paths, masks, markers and filters are referenced this way, so missing
/// one here means a chart silently loses its fill or clipping.
pub const SVG_FUNC_IRI_ATTRS: &[&str] = &[
    "clip-path",
    "color",
    "fill",
    "filter",
    "flood-color",
    "lighting-color",
    "marker-end",
    "marker-mid",
    "marker-start",
    "mask",
    "stroke",
    "stop-color",
];

/// Prefix a single id token. Idempotent, and a no-op on an empty value.
///
/// Idempotency matters because some callers re-sanitize already-sanitized HTML
/// (cached summaries are re-run so a rules bump reaches them), which would
/// otherwise stack up `uc-uc-`. Leaving an authored `uc-foo` unprefixed costs
/// nothing: it still can't collide with an app id, since none start with `uc-`.
pub fn prefix_id(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.starts_with(ID_PREFIX) {
        return value.to_string();
    }
    format!("{ID_PREFIX}{trimmed}")
}

/// Prefix every token of a space-separated idref list (`headers`, ARIA refs).
pub fn prefix_id_list(value: &str) -> String {
    let prefixed: Vec<String> = value.split_whitespace().map(prefix_id).collect();
    if prefixed.is_empty() {
        return value.to_string();
    }
    prefixed.join(" ")
}

/// Prefix a same-document `#fragment` href. Returns None when the value isn't
/// one (absolute URL, or a bare `#` meaning "top of document"), so the caller
/// leaves it untouched.
pub fn prefix_fragment_href(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let fragment = trimmed.strip_prefix('#')?;
    if fragment.is_empty() {
        return None;
    }
    Some(format!("#{}", prefix_id(fragment)))
}

/// Rewrite every `url(#id)` funcIRI in an attribute value, leaving the rest
/// (including `url(https://…)` and non-URL keywords like `none` or a
/// `circle(50%)` basic shape) exactly as it was.
pub fn prefix_func_iris(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    let mut rest = value;
    while let Some(start) = rest.find("url(") {
        let (before, from_url) = rest.split_at(start);
        out.push_str(before);
        let inner_start = start + "url(".len();
        let Some(close) = rest[inner_start..].find(')') else {
            // Unterminated `url(` — emit the remainder verbatim.
            out.push_str(from_url);
            return out;
        };
        let inner = &rest[inner_start..inner_start + close];
        // Strip optional matching quotes: url("#a") / url('#a') / url(#a).
        let unquoted = inner.trim();
        let (quote, bare) = match unquoted.strip_prefix('"').and_then(|s| s.strip_suffix('"')) {
            Some(bare) => ("\"", bare),
            None => match unquoted.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')) {
                Some(bare) => ("'", bare),
                None => ("", unquoted),
            },
        };
        match bare.strip_prefix('#') {
            Some(id) if !id.is_empty() => {
                out.push_str("url(");
                out.push_str(quote);
                out.push('#');
                out.push_str(&prefix_id(id));
                out.push_str(quote);
                out.push(')');
            }
            // Not a same-document reference (e.g. url(https://…)); keep as-is.
            _ => out.push_str(&rest[start..inner_start + close + 1]),
        }
        rest = &rest[inner_start + close + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes_single_id() {
        assert_eq!(prefix_id("intro"), "uc-intro");
        assert_eq!(prefix_id(" intro "), "uc-intro");
    }

    #[test]
    fn prefixing_is_idempotent() {
        assert_eq!(prefix_id("uc-intro"), "uc-intro");
        assert_eq!(prefix_id(&prefix_id("intro")), "uc-intro");
    }

    #[test]
    fn leaves_empty_id_alone() {
        assert_eq!(prefix_id(""), "");
        assert_eq!(prefix_id("   "), "   ");
    }

    #[test]
    fn prefixes_every_token_of_a_list() {
        assert_eq!(prefix_id_list("a b"), "uc-a uc-b");
        assert_eq!(prefix_id_list("  a   b  "), "uc-a uc-b");
        assert_eq!(prefix_id_list(""), "");
    }

    #[test]
    fn prefixes_fragment_hrefs_only() {
        assert_eq!(prefix_fragment_href("#intro").unwrap(), "#uc-intro");
        assert_eq!(prefix_fragment_href("#bib.bib19").unwrap(), "#uc-bib.bib19");
        // Bare `#` means top of document — prefixing would break it.
        assert!(prefix_fragment_href("#").is_none());
        assert!(prefix_fragment_href("https://example.com/#intro").is_none());
        assert!(prefix_fragment_href("/page#intro").is_none());
    }

    #[test]
    fn rewrites_func_iri_references() {
        assert_eq!(prefix_func_iris("url(#grad)"), "url(#uc-grad)");
        assert_eq!(prefix_func_iris(r##"url("#grad")"##), r##"url("#uc-grad")"##);
        assert_eq!(prefix_func_iris("url('#grad')"), "url('#uc-grad')");
        // Paint fallback after the reference survives.
        assert_eq!(prefix_func_iris("url(#grad) red"), "url(#uc-grad) red");
        // Multiple references in one value (e.g. a marker shorthand).
        assert_eq!(prefix_func_iris("url(#a) url(#b)"), "url(#uc-a) url(#uc-b)");
    }

    #[test]
    fn leaves_non_fragment_values_alone() {
        assert_eq!(prefix_func_iris("none"), "none");
        assert_eq!(prefix_func_iris("#ff0000"), "#ff0000");
        assert_eq!(prefix_func_iris("circle(50%)"), "circle(50%)");
        assert_eq!(
            prefix_func_iris("url(https://example.com/g.svg#x)"),
            "url(https://example.com/g.svg#x)"
        );
        assert_eq!(prefix_func_iris("url(#)"), "url(#)");
        // Unterminated: emitted verbatim rather than mangled.
        assert_eq!(prefix_func_iris("url(#grad"), "url(#grad");
    }
}
