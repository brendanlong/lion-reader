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
}
