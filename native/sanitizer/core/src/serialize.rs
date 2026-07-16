//! Serialization helpers shared by the MathJax and SVG rewriters.
//!
//! Escaping matches what dom-serializer's `encodeEntities: "utf8"` mode did
//! in the TypeScript implementation: text escapes `& < >`, attribute values
//! escape `& < "` — everything else (including astral-plane math glyphs) is
//! emitted as raw UTF-8.

use scraper::ElementRef;

pub fn escape_text(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(c),
        }
    }
}

pub fn escape_attr(s: &str, out: &mut String) {
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
}

/// A minimal owned tree for building MathML output (the TS code built
/// domhandler `Element`s and serialized them; we build these instead).
pub enum MNode {
    Elem {
        name: &'static str,
        attrs: Vec<(String, String)>,
        children: Vec<MNode>,
    },
    Text(String),
}

impl MNode {
    pub fn elem(name: &'static str, children: Vec<MNode>) -> MNode {
        MNode::Elem { name, attrs: Vec::new(), children }
    }

    pub fn elem_with_attrs(
        name: &'static str,
        attrs: Vec<(String, String)>,
        children: Vec<MNode>,
    ) -> MNode {
        MNode::Elem { name, attrs, children }
    }
}

/// Serialize built MathML nodes (HTML style: no self-closing tags, matching
/// the old dom-serializer HTML-mode output for `<mspace></mspace>` etc.).
pub fn serialize_mnodes(nodes: &[MNode], out: &mut String) {
    for node in nodes {
        match node {
            MNode::Text(t) => escape_text(t, out),
            MNode::Elem { name, attrs, children } => {
                out.push('<');
                out.push_str(name);
                for (k, v) in attrs {
                    out.push(' ');
                    out.push_str(k);
                    out.push_str("=\"");
                    escape_attr(v, out);
                    out.push('"');
                }
                out.push('>');
                serialize_mnodes(children, out);
                out.push_str("</");
                out.push_str(name);
                out.push('>');
            }
        }
    }
}

/// The serialized name of an attribute, including its namespace prefix when
/// present (`xlink:href`, `xml:space`).
pub fn attr_display_name(name: &html5ever::QualName) -> String {
    match &name.prefix {
        Some(prefix) => format!("{}:{}", prefix, name.local),
        None => name.local.to_string(),
    }
}

/// Serialize a parsed element subtree verbatim-ish (elements + text only;
/// comments and other node types are dropped). Used for MathJax's assistive
/// MathML, which is trusted ground truth and still flows through the main
/// sanitizer pass afterwards. `extra_attrs` are appended if not present.
pub fn serialize_subtree(el: ElementRef, extra_attrs: &[(&str, &str)], out: &mut String) {
    let value = el.value();
    out.push('<');
    out.push_str(value.name());
    let mut seen: Vec<String> = Vec::new();
    for (name, attr_value) in value.attrs.iter() {
        let display = attr_display_name(name);
        out.push(' ');
        out.push_str(&display);
        out.push_str("=\"");
        escape_attr(attr_value, out);
        out.push('"');
        seen.push(display);
    }
    for (name, attr_value) in extra_attrs {
        if !seen.iter().any(|s| s == name) {
            out.push(' ');
            out.push_str(name);
            out.push_str("=\"");
            escape_attr(attr_value, out);
            out.push('"');
        }
    }
    out.push('>');
    for child in el.children() {
        if let Some(child_el) = ElementRef::wrap(child) {
            serialize_subtree(child_el, &[], out);
        } else if let Some(text) = child.value().as_text() {
            escape_text(text, out);
        }
    }
    out.push_str("</");
    out.push_str(value.name());
    out.push('>');
}
