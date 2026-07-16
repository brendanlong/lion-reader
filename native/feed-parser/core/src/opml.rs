//! OPML parser — a direct port of the old
//! `src/server/feed/streaming/opml-parser.ts`. Structural validation errors
//! (missing opml/body elements) are reported via flags on [`OpmlResult`] so
//! the error type and messages stay in TypeScript.

use crate::types::{OpmlFeed, OpmlResult};
use crate::xml::{js_trim, run_sax, Attrs, SaxHandler};

struct OpmlHandler {
    result: OpmlResult,
    category_stack: Vec<String>,
    in_body: bool,
    outline_depth: i64,
}

impl SaxHandler for OpmlHandler {
    fn on_open(&mut self, tag: &str, attrs: &Attrs) {
        if tag == "opml" {
            self.result.has_opml = true;
        }

        if tag == "body" {
            self.result.has_body = true;
            self.in_body = true;
        }

        if tag == "outline" && self.in_body {
            self.outline_depth += 1;

            // The old parser kept attribute names case-sensitive
            // (`lowerCaseAttributeNames: false`) and checked exactly these
            // spellings; empty values are falsy and fall through.
            let xml_url = attrs
                .get_nonempty("xmlurl")
                .or_else(|| attrs.get_nonempty("xmlUrl"));
            let text = attrs
                .get_nonempty("text")
                .or_else(|| attrs.get_nonempty("title"));
            let html_url = attrs
                .get_nonempty("htmlurl")
                .or_else(|| attrs.get_nonempty("htmlUrl"));
            let outline_type = attrs.get_nonempty("type");
            let category_attr = attrs.get_nonempty("category");

            if let Some(xml_url) = xml_url {
                let category = if !self.category_stack.is_empty() {
                    Some(self.category_stack.clone())
                } else if let Some(category_attr) = category_attr {
                    if category_attr.contains('/') {
                        Some(
                            category_attr
                                .split('/')
                                .map(|c| js_trim(c).to_string())
                                .collect(),
                        )
                    } else if category_attr.contains(',') {
                        Some(vec![js_trim(
                            category_attr.split(',').next().unwrap_or_default(),
                        )
                        .to_string()])
                    } else {
                        Some(vec![js_trim(category_attr).to_string()])
                    }
                } else {
                    None
                };

                self.result.feeds.push(OpmlFeed {
                    xml_url: xml_url.to_string(),
                    title: text.map(str::to_string),
                    html_url: html_url.map(str::to_string),
                    category,
                });
            } else if let (Some(text), None) = (text, outline_type) {
                // A folder: an outline with a label but no feed URL and no type.
                self.category_stack.push(text.to_string());
            }
        }
    }

    fn on_text(&mut self, _text: &str) {}

    fn on_close(&mut self, tag: &str) {
        if tag == "body" {
            self.in_body = false;
        }

        if tag == "outline" && self.in_body {
            self.outline_depth -= 1;
            while self.category_stack.len() as i64 > self.outline_depth {
                self.category_stack.pop();
            }
        }
    }
}

/// Parses an OPML file from a string. XML-level parse failures are `Err`;
/// structural validation is left to the caller via the `has_*` flags.
pub fn parse_opml(content: &str) -> Result<OpmlResult, String> {
    let mut handler = OpmlHandler {
        result: OpmlResult::default(),
        category_stack: Vec::new(),
        in_body: false,
        outline_depth: 0,
    };
    run_sax(content, false, &mut handler)?;
    Ok(handler.result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_folders() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
            <opml version="2.0">
              <head><title>My Subscriptions</title></head>
              <body>
                <outline text="Tech">
                  <outline text="Programming">
                    <outline type="rss" text="Coding Blog" xmlUrl="https://coding.com/feed"/>
                  </outline>
                  <outline type="rss" text="Tech News" xmlUrl="https://technews.com/rss"/>
                </outline>
                <outline type="rss" text="Solo" xmlurl="https://solo.com/feed" htmlUrl="https://solo.com"/>
              </body>
            </opml>"#;
        let result = parse_opml(xml).unwrap();
        assert!(result.has_opml && result.has_body);
        assert_eq!(result.feeds.len(), 3);
        assert_eq!(
            result.feeds[0].category.as_deref(),
            Some(&["Tech".to_string(), "Programming".to_string()][..])
        );
        assert_eq!(
            result.feeds[1].category.as_deref(),
            Some(&["Tech".to_string()][..])
        );
        assert_eq!(result.feeds[2].category, None);
        assert_eq!(result.feeds[2].xml_url, "https://solo.com/feed");
        assert_eq!(result.feeds[2].html_url.as_deref(), Some("https://solo.com"));
    }

    #[test]
    fn reports_missing_structure() {
        let result = parse_opml(r#"<rss version="2.0"><channel></channel></rss>"#).unwrap();
        assert!(!result.has_opml);
        assert!(!result.has_body);
    }
}
