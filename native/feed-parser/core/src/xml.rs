//! Shared SAX plumbing: a quick-xml event pump that presents the same
//! open/text/close callback surface the old htmlparser2 parsers were written
//! against, plus ports of the JS-side helpers the state machines relied on
//! (entity decoding, `String.prototype.trim`, `parseInt`).
//!
//! Parity notes (the old parsers ran htmlparser2 in `xmlMode` with
//! `decodeEntities: true`):
//! - Entity decoding is XML-strict: only the five predefined entities and
//!   numeric character references are decoded (semicolon required); anything
//!   else — including HTML names like `&nbsp;` — is left literal, exactly as
//!   htmlparser2's xml decode tree does. Feed bodies are HTML, so unknown
//!   entities must survive for the browser/sanitizer to handle.
//! - CDATA content stays literal (no entity decoding).
//! - The reader is configured to be as forgiving as quick-xml allows
//!   (unmatched/mismatched end tags, dangling `&`), because real-world feeds
//!   contain unclosed elements the old parsers tolerated.

use quick_xml::events::Event;
use quick_xml::Reader;

/// Attributes of an open tag: `(name, entity-decoded value)` pairs in
/// document order. Lookups take the **last** occurrence of a duplicate name,
/// mirroring JS object assignment (`attribs[name] = value` per attribute).
pub struct Attrs(Vec<(String, String)>);

impl Attrs {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .rev()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    /// JS-truthy lookup: `Some` only when the attribute exists and is
    /// non-empty (an empty string is falsy in the old JS checks).
    pub fn get_nonempty(&self, name: &str) -> Option<&str> {
        self.get(name).filter(|v| !v.is_empty())
    }
}

/// Callback surface matching htmlparser2's `onopentag`/`ontext`/`onclosetag`.
/// Tag names arrive ASCII-lowercased (the old parsers used
/// `lowerCaseTags: true`); text arrives entity-decoded.
pub trait SaxHandler {
    fn on_open(&mut self, name: &str, attrs: &Attrs);
    fn on_text(&mut self, text: &str);
    fn on_close(&mut self, name: &str);
}

/// Pump quick-xml events through a [`SaxHandler`]. `lowercase_attr_names`
/// mirrors htmlparser2's `lowerCaseAttributeNames` (true for RSS/Atom, false
/// for OPML, which matches `xmlUrl`/`xmlurl` case-sensitively).
pub fn run_sax<H: SaxHandler>(
    content: &str,
    lowercase_attr_names: bool,
    handler: &mut H,
) -> Result<(), String> {
    // htmlparser2 tolerated a leading BOM (it became an ignored text node);
    // strip it so quick-xml doesn't reject the document.
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);

    let mut reader = Reader::from_str(content);
    let config = reader.config_mut();
    config.check_end_names = false;
    config.allow_unmatched_ends = true;
    config.allow_dangling_amp = true;
    config.check_comments = false;
    // Self-closing tags fire open+close, as htmlparser2 does in xmlMode.
    config.expand_empty_elements = true;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_ascii_lowercase();
                let mut attrs = Vec::new();
                for attr in e.attributes().with_checks(false) {
                    // A malformed attribute ends attribute processing for this
                    // tag (best-effort leniency; htmlparser2 never errored).
                    let Ok(attr) = attr else { break };
                    let mut key = String::from_utf8_lossy(attr.key.as_ref()).into_owned();
                    if lowercase_attr_names {
                        key = key.to_ascii_lowercase();
                    }
                    let value =
                        decode_xml_entities(&String::from_utf8_lossy(&attr.value)).into_owned();
                    attrs.push((key, value));
                }
                handler.on_open(&name, &Attrs(attrs));
            }
            Ok(Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_ascii_lowercase();
                handler.on_close(&name);
            }
            // Entity/character references are separate events; text between
            // them arrives literal, so no unescape pass is needed here.
            Ok(Event::Text(t)) => match t.into_inner() {
                std::borrow::Cow::Borrowed(bytes) => {
                    handler.on_text(&String::from_utf8_lossy(bytes))
                }
                std::borrow::Cow::Owned(bytes) => handler.on_text(&String::from_utf8_lossy(&bytes)),
            },
            // CDATA stays literal — matching htmlparser2, where escaped HTML
            // in a CDATA body must not be entity-decoded a second time.
            Ok(Event::CData(c)) => {
                let bytes = c.into_inner();
                handler.on_text(&String::from_utf8_lossy(&bytes));
            }
            Ok(Event::GeneralRef(r)) => {
                let name = String::from_utf8_lossy(r.as_ref()).into_owned();
                handler.on_text(&resolve_entity_ref(&name));
            }
            Ok(Event::Eof) => return Ok(()),
            // Declarations, processing instructions, comments, doctypes.
            Ok(_) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Resolve the content of an entity/character reference (the part between
/// `&` and `;`). Unknown references are returned literally (`&name;`),
/// matching htmlparser2's strict XML decoder.
pub fn resolve_entity_ref(name: &str) -> String {
    if let Some(num) = name.strip_prefix('#') {
        let code = if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
            parse_code_point(hex, 16)
        } else {
            parse_code_point(num, 10)
        };
        return match code {
            Some(code) => replace_code_point(code).to_string(),
            None => format!("&{name};"),
        };
    }
    match name {
        "amp" => "&".to_string(),
        "lt" => "<".to_string(),
        "gt" => ">".to_string(),
        "quot" => "\"".to_string(),
        "apos" => "'".to_string(),
        _ => format!("&{name};"),
    }
}

fn parse_code_point(digits: &str, radix: u32) -> Option<u32> {
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    // Overflow means "way out of range", which replace_code_point maps to
    // U+FFFD — the same outcome as the JS decoder's accumulated number.
    Some(u32::from_str_radix(digits, radix).unwrap_or(0x11_0000))
}

/// Port of the `entities` package's `replaceCodePoint` (used by htmlparser2
/// for numeric character references): surrogates and out-of-range code
/// points become U+FFFD, and the C1 control range is remapped per the HTML
/// spec's windows-1252 table.
fn replace_code_point(code: u32) -> char {
    if (0xD800..=0xDFFF).contains(&code) || code > 0x10FFFF {
        return '\u{FFFD}';
    }
    let code = match code {
        0x80 => 0x20AC,
        0x82 => 0x201A,
        0x83 => 0x0192,
        0x84 => 0x201E,
        0x85 => 0x2026,
        0x86 => 0x2020,
        0x87 => 0x2021,
        0x88 => 0x02C6,
        0x89 => 0x2030,
        0x8A => 0x0160,
        0x8B => 0x2039,
        0x8C => 0x0152,
        0x8E => 0x017D,
        0x91 => 0x2018,
        0x92 => 0x2019,
        0x93 => 0x201C,
        0x94 => 0x201D,
        0x95 => 0x2022,
        0x96 => 0x2013,
        0x97 => 0x2014,
        0x98 => 0x02DC,
        0x99 => 0x2122,
        0x9A => 0x0161,
        0x9B => 0x203A,
        0x9C => 0x0153,
        0x9E => 0x017E,
        0x9F => 0x0178,
        other => other,
    };
    char::from_u32(code).unwrap_or('\u{FFFD}')
}

/// Decode XML entity/character references in a string (used for attribute
/// values, which quick-xml hands over raw). Same rules as
/// [`resolve_entity_ref`]: the five predefined entities plus numeric
/// references; everything else stays literal.
pub fn decode_xml_entities(input: &str) -> std::borrow::Cow<'_, str> {
    if !input.contains('&') {
        return std::borrow::Cow::Borrowed(input);
    }
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let after = &rest[pos + 1..];
        if let Some(semi) = after.find(';') {
            let name = &after[..semi];
            if !name.is_empty()
                && name.len() <= 32
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '#')
            {
                out.push_str(&resolve_entity_ref(name));
                rest = &after[semi + 1..];
                continue;
            }
        }
        out.push('&');
        rest = after;
    }
    out.push_str(rest);
    std::borrow::Cow::Owned(out)
}

/// `String.prototype.trim` — trims the JS WhiteSpace ∪ LineTerminator set,
/// which differs from Rust's `str::trim` by including U+FEFF (ZWNBSP).
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// `parseInt(s, 10)`: skip leading whitespace, optional sign, then the
/// longest ASCII-digit prefix; `None` when there are no digits (NaN).
pub fn js_parse_int(s: &str) -> Option<f64> {
    let t = s.trim_start_matches(is_js_whitespace);
    let (negative, t) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: &str = &t[..t.bytes().take_while(|b| b.is_ascii_digit()).count()];
    if digits.is_empty() {
        return None;
    }
    let mut value = 0f64;
    for b in digits.bytes() {
        value = value * 10.0 + f64::from(b - b'0');
    }
    Some(if negative { -value } else { value })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_predefined_and_numeric_refs_only() {
        assert_eq!(decode_xml_entities("a &amp; b"), "a & b");
        assert_eq!(decode_xml_entities("&lt;p&gt;"), "<p>");
        assert_eq!(decode_xml_entities("&#039;"), "'");
        assert_eq!(decode_xml_entities("&#x27;"), "'");
        // HTML-only names stay literal (xmlMode parity).
        assert_eq!(decode_xml_entities("a&nbsp;b"), "a&nbsp;b");
        // No semicolon → literal.
        assert_eq!(decode_xml_entities("a &amp b"), "a &amp b");
        // C1 remap and out-of-range.
        assert_eq!(decode_xml_entities("&#128;"), "\u{20AC}");
        assert_eq!(decode_xml_entities("&#xD800;"), "\u{FFFD}");
        assert_eq!(decode_xml_entities("&#99999999999;"), "\u{FFFD}");
        assert_eq!(decode_xml_entities("&#;"), "&#;");
    }

    #[test]
    fn js_parse_int_matches_parseint() {
        assert_eq!(js_parse_int("60"), Some(60.0));
        assert_eq!(js_parse_int("  42abc"), Some(42.0));
        assert_eq!(js_parse_int("3.9"), Some(3.0));
        assert_eq!(js_parse_int("-5"), Some(-5.0));
        assert_eq!(js_parse_int("abc"), None);
        assert_eq!(js_parse_int(""), None);
    }
}
