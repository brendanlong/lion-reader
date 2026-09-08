//! Nesting-depth guard for the two tree-building passes.
//!
//! The lol_html allow-list pass streams, but the MathJax and SVG passes parse
//! their located substrings into a real DOM and walk it with mutually
//! recursive functions (`emit_svg_element`, `convert_element`,
//! `serialize_subtree`, …) — one frame per nesting level. Feed HTML is fully
//! attacker-controlled and a few hundred KB of `<g>` buys tens of thousands of
//! levels, which **overflows the stack and kills the process**: a stack
//! overflow is not an unwind, so the `catch_unwind` guards in `lib.rs` never
//! see it. Sanitization runs on every read, so one stored entry would crash
//! the server on every read of it.
//!
//! So each parsed fragment is depth-checked *before* anything recurses over
//! it, and an over-deep fragment takes the degradation path that pass already
//! has for an unusable range (SVG dropped / MathJax container spliced through
//! verbatim). The check itself must be iterative, or it would overflow on
//! exactly the input it exists to reject.

use scraper::Html;

/// Maximum nesting depth of a fragment handed to a recursive pass. Matches
/// `MAX_DOM_DEPTH` in `native/readability/src/lib.rs` and, like it, sits far
/// above anything real: articles nest a few dozen levels and Blink itself
/// flattens the tree beyond 512.
///
/// Margin: in the release build these passes cost under 1 KB of stack per
/// level (measured — the MathJax path, the heavier of the two, overflows
/// between 8k and 12k levels on the 8 MB stacks Node's main thread and libuv
/// pool threads get), so 512 uses well under a tenth of it. The debug build's
/// un-inlined frames are several times fatter, which is why the "legitimate
/// nesting still converts" tests sit at 100 rather than at the limit.
pub const MAX_DOM_DEPTH: usize = 512;

/// Whether the parsed fragment nests deeper than [`MAX_DOM_DEPTH`].
///
/// Iterative by construction — the traversal state lives in a heap `Vec`, so
/// this stays safe on the pathological input it is meant to catch.
pub fn exceeds_max_depth(fragment: &Html) -> bool {
    let mut stack = vec![(fragment.tree.root(), 1usize)];
    while let Some((node, depth)) = stack.pop() {
        if depth > MAX_DOM_DEPTH {
            return true;
        }
        if let Some(sibling) = node.next_sibling() {
            stack.push((sibling, depth));
        }
        if let Some(child) = node.first_child() {
            stack.push((child, depth + 1));
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn depth_html(levels: usize) -> String {
        format!("<svg>{}x{}</svg>", "<g>".repeat(levels), "</g>".repeat(levels))
    }

    #[test]
    fn ordinary_markup_is_under_the_limit() {
        let fragment = Html::parse_fragment("<div><p>text <em>with <b>emphasis</b></em></p></div>");
        assert!(!exceeds_max_depth(&fragment));
    }

    #[test]
    fn empty_fragment_is_under_the_limit() {
        assert!(!exceeds_max_depth(&Html::parse_fragment("")));
    }

    #[test]
    fn wide_but_shallow_markup_is_under_the_limit() {
        // Breadth is not depth: the guard must not reject a long flat list.
        let fragment = Html::parse_fragment(&"<p>x</p>".repeat(50_000));
        assert!(!exceeds_max_depth(&fragment));
    }

    #[test]
    fn deep_markup_is_over_the_limit() {
        assert!(exceeds_max_depth(&Html::parse_fragment(&depth_html(MAX_DOM_DEPTH + 50))));
    }

    #[test]
    fn pathological_depth_does_not_overflow_the_stack() {
        // The whole point: the depth check runs on input deep enough to
        // overflow a recursive walk (this is the crashing repro's depth).
        assert!(exceeds_max_depth(&Html::parse_fragment(&depth_html(20_000))));
    }
}
