//! Generic attribute rewriting on lol_html, for TS callers that keep the
//! policy (what a value becomes) on their side — `absolutizeUrls` in
//! `src/server/feed/content-cleaner.ts`. Not part of the sanitizer pipeline.
//!
//! Only start tags whose attribute actually changes are re-serialized; every
//! other byte passes through untouched.

use std::borrow::Cow;
use std::cell::RefCell;

use lol_html::html_content::Element;
use lol_html::{rewrite_str, ElementContentHandlers, HandlerResult, RewriteStrSettings, Selector};

#[derive(Debug)]
pub enum RewriteError<E> {
    /// The first error `rewrite` returned; rewriting stopped there.
    Callback(E),
    /// lol_html refused the input (e.g. a parsing ambiguity in strict mode)
    /// or an attribute name.
    Rewriter(String),
}

/// Calls `rewrite(tag_name, attribute_name, raw_value)` for each of `names`
/// present on each element, in document order, and writes back the returned
/// value when it is `Some` and differs. Values are raw (not entity-decoded),
/// read and written the way lol_html does: `set_attribute` escapes only `"`.
pub fn rewrite_attributes<E>(
    html: &str,
    names: &[String],
    rewrite: impl FnMut(&str, &str, &str) -> Result<Option<String>, E>,
) -> Result<String, RewriteError<E>> {
    let rewrite = RefCell::new(rewrite);
    let callback_error: RefCell<Option<E>> = RefCell::new(None);

    let mut handlers = Vec::with_capacity(names.len());
    for name in names {
        let selector: Selector = format!("[{name}]")
            .parse()
            .map_err(|e| RewriteError::Rewriter(format!("invalid attribute name {name:?}: {e}")))?;
        let (rewrite, callback_error) = (&rewrite, &callback_error);
        let handler = move |el: &mut Element| -> HandlerResult {
            let Some(value) = el.get_attribute(name) else {
                return Ok(());
            };
            match (rewrite.borrow_mut())(&el.tag_name(), name, &value) {
                Ok(Some(new_value)) if new_value != value => {
                    el.set_attribute(name, &new_value)?;
                }
                Ok(_) => {}
                Err(e) => {
                    *callback_error.borrow_mut() = Some(e);
                    return Err("attribute rewrite callback failed".into());
                }
            }
            Ok(())
        };
        handlers.push((
            Cow::Owned(selector),
            ElementContentHandlers::default().element(handler),
        ));
    }

    let result = rewrite_str(
        html,
        RewriteStrSettings {
            element_content_handlers: handlers,
            ..RewriteStrSettings::new()
        },
    );
    if let Some(e) = callback_error.into_inner() {
        return Err(RewriteError::Callback(e));
    }
    result.map_err(|e| RewriteError::Rewriter(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn untouched_markup_is_byte_identical() {
        let html =
            "<!DOCTYPE html><P CLASS=x Href='a'>t&amp;<img src=\"same\" alt=y></P><!-- c -->";
        let out = rewrite_attributes(html, &names(&["href", "src"]), |_, _, v| {
            Ok::<_, ()>(Some(v.to_string()))
        })
        .unwrap();
        assert_eq!(out, html);
    }

    #[test]
    fn calls_back_in_document_order_and_writes_changes() {
        let html = r#"<base href="b"><a href="x"><img src='y' srcset="z"></a>"#;
        let mut seen = Vec::new();
        let out = rewrite_attributes(html, &names(&["href", "src"]), |tag, name, value| {
            seen.push(format!("{tag}.{name}={value}"));
            Ok::<_, ()>((tag == "img").then(|| "q\"r".to_string()))
        })
        .unwrap();
        assert_eq!(seen, ["base.href=b", "a.href=x", "img.src=y"]);
        assert_eq!(
            out,
            r#"<base href="b"><a href="x"><img src="q&quot;r" srcset="z"></a>"#
        );
    }

    #[test]
    fn callback_error_stops_the_rewrite() {
        let mut calls = 0;
        let result = rewrite_attributes(
            r#"<a href="1"></a><a href="2"></a>"#,
            &names(&["href"]),
            |_, _, _| {
                calls += 1;
                Err::<Option<String>, _>("boom")
            },
        );
        assert!(matches!(result, Err(RewriteError::Callback("boom"))));
        assert_eq!(calls, 1);
    }
}
