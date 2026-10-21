//! The `class` allow-list.
//!
//! Entry HTML renders inside the app's own document, styled by the app's
//! Tailwind stylesheet, so a feed's class names pick up *our* utilities. Sites
//! built with Tailwind (X, among many) ship exactly those names: a link with
//! `class="absolute inset-0 z-10"` covered the whole reader pane and turned
//! every click into a navigation, and `fixed`/`hidden`/`opacity-0` would let a
//! feed hide content or lay an invisible link over the app. So a class survives
//! only if it is one the reader stylesheets deliberately style:
//! `src/app/reader-prose.css`, which both the web and Android readers load.

/// Classes kept on entry content. Add one here when a reader stylesheet starts
/// styling it.
const ALLOWED_CLASSES: &[&str] = &[
    // CKEditor 5 footnotes (LessWrong and other ForumMagnum sites).
    "footnote-section",
    "footnote-content",
    "footnote-back-link",
    // KaTeX's MathML / HTML twins.
    "katex-mathml",
    "katex-html",
];

/// The allow-listed tokens of a `class` value, space-joined, or None when none
/// survive (drop the attribute). Matches raw tokens: an allow-listed name has
/// no `&`, so an entity-encoded spelling can only fail to match, never smuggle
/// in a different name.
pub fn filter_classes(value: &str) -> Option<String> {
    let kept: Vec<&str> = value
        .split_ascii_whitespace()
        .filter(|token| ALLOWED_CLASSES.contains(token))
        .collect();
    (!kept.is_empty()).then(|| kept.join(" "))
}
