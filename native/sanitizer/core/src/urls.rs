//! URL-scheme validation for attribute values.
//!
//! Values are checked the way a browser will interpret them: HTML
//! entity-decoded first (`java&#115;cript:` decodes before the URL parser
//! sees it), then with ASCII control characters and spaces stripped for the
//! scheme sniff (`java\tscript:` — browsers strip tab/newline inside URLs).
//! The check is allow-list shaped, so anything ambiguous fails closed.

use std::borrow::Cow;

/// Entity-decode an attribute value once (the single decode a browser does).
pub fn decode_attr(value: &str) -> Cow<'_, str> {
    html_escape::decode_html_entities(value)
}

/// The URL scheme of a (decoded) value, lowercased — or None when it has
/// none (relative path, `#fragment`, or protocol-relative `//host`).
pub fn url_scheme(decoded: &str) -> Option<String> {
    let cleaned: String = decoded
        .chars()
        .filter(|c| !matches!(c, '\u{0000}'..='\u{0020}'))
        .collect::<String>()
        .to_ascii_lowercase();
    let mut chars = cleaned.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    let mut scheme = String::new();
    scheme.push(first);
    for c in chars {
        if c == ':' {
            return Some(scheme);
        }
        if c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-') {
            scheme.push(c);
        } else {
            return None;
        }
    }
    None
}

/// Whether a decoded URL value is allowed: no scheme (relative /
/// protocol-relative), or one of `schemes`.
pub fn is_url_allowed(decoded: &str, schemes: &[&str]) -> bool {
    match url_scheme(decoded) {
        None => true,
        Some(scheme) => schemes.contains(&scheme.as_str()),
    }
}

/// Whether a `data:` value declares an `image/` MIME type — the only `data:`
/// form we ever allow as an image source. `data:image/svg+xml` is included on
/// purpose: an SVG loaded through `<img>`/`<image>`/`srcset` is a *passive*
/// image context (no script execution, no external subresource loads), so it
/// is safe to render, whereas `data:text/html` / `data:application/*` are not
/// images and must never reach an image sink. The value is normalized the same
/// way `url_scheme` sees it (control/space stripped, lowercased) so obfuscated
/// prefixes like `data:\timage/...` can't slip past.
pub fn is_data_image(decoded: &str) -> bool {
    let cleaned: String = decoded
        .chars()
        .filter(|c| !matches!(c, '\u{0000}'..='\u{0020}'))
        .collect::<String>()
        .to_ascii_lowercase();
    cleaned.starts_with("data:image/")
}

/// Image-source URL check: like [`is_url_allowed`], but a `data:` URL is
/// additionally required to be an `image/` MIME type (see [`is_data_image`]).
/// Use this for every attribute whose value the browser loads as an image
/// (`img`/`source` `src`, `srcset` candidates, SVG `<image>` href).
pub fn is_image_url_allowed(decoded: &str, schemes: &[&str]) -> bool {
    match url_scheme(decoded) {
        None => true,
        Some(scheme) => {
            if !schemes.contains(&scheme.as_str()) {
                return false;
            }
            if scheme == "data" {
                return is_data_image(decoded);
            }
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_schemes_through_obfuscation() {
        assert_eq!(url_scheme("javascript:alert(1)").as_deref(), Some("javascript"));
        assert_eq!(url_scheme("JAVASCRIPT:alert(1)").as_deref(), Some("javascript"));
        assert_eq!(url_scheme("java\tscript:alert(1)").as_deref(), Some("javascript"));
        assert_eq!(url_scheme("  javascript:alert(1)").as_deref(), Some("javascript"));
        assert_eq!(
            url_scheme(&decode_attr("java&#115;cript:alert(1)")).as_deref(),
            Some("javascript")
        );
    }

    #[test]
    fn relative_and_protocol_relative_have_no_scheme() {
        assert_eq!(url_scheme("/path"), None);
        assert_eq!(url_scheme("#frag"), None);
        assert_eq!(url_scheme("//example.com/x"), None);
        assert_eq!(url_scheme("path/with:colon"), None); // '/' before ':'
    }

    #[test]
    fn allow_list_semantics() {
        assert!(is_url_allowed("https://x.com", &["http", "https"]));
        assert!(is_url_allowed("/relative", &["http", "https"]));
        assert!(!is_url_allowed("javascript:x", &["http", "https"]));
        assert!(!is_url_allowed("data:text/html,x", &["http", "https"]));
        assert!(is_url_allowed("data:image/png;base64,x", &["http", "https", "data"]));
    }

    #[test]
    fn data_image_mime_gate() {
        // Only image/* data URLs count as images.
        assert!(is_data_image("data:image/png;base64,AAA="));
        assert!(is_data_image("data:image/svg+xml,<svg></svg>"));
        assert!(is_data_image("DATA:IMAGE/PNG;base64,AAA="));
        assert!(is_data_image("data:\timage/png;base64,AAA="));
        assert!(!is_data_image("data:text/html,<script>"));
        assert!(!is_data_image("data:application/javascript,x"));
        assert!(!is_data_image("data:,plain"));
    }

    #[test]
    fn image_url_allow_gates_data_by_mime() {
        let schemes = &["http", "https", "data"];
        assert!(is_image_url_allowed("https://x.com/a.png", schemes));
        assert!(is_image_url_allowed("/relative.png", schemes));
        assert!(is_image_url_allowed("data:image/png;base64,AAA=", schemes));
        assert!(is_image_url_allowed("data:image/svg+xml,<svg/>", schemes));
        // data: with a non-image MIME is rejected even though `data` is listed.
        assert!(!is_image_url_allowed("data:text/html,<script>", schemes));
        assert!(!is_image_url_allowed("data:application/pdf,x", schemes));
        // Non-listed schemes still rejected.
        assert!(!is_image_url_allowed("javascript:x", schemes));
    }
}
