//! Core logic of the Lion Reader entry-HTML sanitizer.
//!
//! This crate is pure Rust (no N-API) so it can be unit-tested with plain
//! `cargo test`. The thin napi wrapper crate in the parent directory exposes
//! [`sanitize_entry_html`] and [`embeds::normalize_embed`] to Node.
//!
//! The pipeline mirrors `sanitizeEntryHtml` in the old
//! `src/server/html/sanitize.ts`:
//!
//! 1. MathJax CHTML → MathML conversion (mathjax.rs), so equations survive
//!    sanitization. Degrades to "math stripped" on error.
//! 2. Inline-SVG extraction + sanitization (svg.rs), replacing each SVG with
//!    an opaque placeholder. Degrades to "SVG stripped" on error.
//! 3. The lol_html allow-list pass (sanitize.rs).
//! 4. SVG re-insertion.
//!
//! Bump [`SANITIZER_VERSION`] whenever any of this changes behavior — the
//! persisted-sanitized-content machinery uses it for staleness.

pub mod embeds;
pub mod mathjax;
pub mod sanitize;
pub mod scanner;
pub mod serialize;
pub mod svg;
pub mod urls;

/// Version of the sanitization rules. The single source of truth — the
/// TypeScript `SANITIZER_VERSION` re-exports this value via the napi
/// binding. v9 = the Rust port (output differs from sanitize-html in
/// formatting, so every row must be re-sanitized).
pub const SANITIZER_VERSION: u32 = 9;

/// Run the full sanitization pipeline. `warnings` collects non-fatal
/// diagnostics (e.g. unrecognized MathJax wrappers) for the caller to log.
pub fn sanitize_entry_html(html: &str, warnings: &mut Vec<String>) -> Result<String, String> {
    // MathJax CHTML → MathML. A pathological input must degrade to "math
    // stripped" rather than fail the write path, so scanner/parse panics are
    // caught and the raw HTML sanitized instead.
    let transformed = match std::panic::catch_unwind(|| {
        let mut w = Vec::new();
        let out = mathjax::convert_mathjax_chtml(html, &mut w);
        (out, w)
    }) {
        Ok((out, w)) => {
            warnings.extend(w);
            out
        }
        Err(_) => {
            warnings.push("MathJax CHTML conversion panicked; sanitizing raw HTML".to_string());
            None
        }
    };
    let transformed = transformed.as_deref().unwrap_or(html);

    // Inline SVG extraction. Degrades to "SVG stripped" (the main pass drops
    // <svg>) on error.
    let extraction = std::panic::catch_unwind(|| svg::extract_inline_svg(transformed)).ok();
    let (body, extraction) = match &extraction {
        Some(extraction) => (extraction.html.as_str(), Some(extraction)),
        None => {
            warnings.push("Inline SVG extraction panicked; sanitizing without it".to_string());
            (transformed, None)
        }
    };

    // The allow-list pass is the security-critical step; on any internal
    // panic it must fail CLOSED (drop the whole body) rather than risk
    // emitting partially-processed output. `catch_unwind` mirrors the
    // math/SVG stages above; a returned Err propagates to the caller as a
    // thrown JS error (never unsanitized HTML).
    let sanitized = match std::panic::catch_unwind(|| sanitize::sanitize_html_pass(body)) {
        Ok(result) => result?,
        Err(_) => return Err("sanitize pass panicked".to_string()),
    };

    Ok(match extraction {
        Some(extraction) if !extraction.svgs.is_empty() => {
            svg::reinsert_inline_svg(&sanitized, extraction)
        }
        _ => sanitized,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(html: &str) -> String {
        let mut warnings = Vec::new();
        sanitize_entry_html(html, &mut warnings).unwrap()
    }

    #[test]
    fn full_pipeline_math_svg_and_html() {
        let html = concat!(
            r#"<p onclick="x">Equation <mjx-container><mjx-math><mjx-mi><mjx-c class="mjx-c1D465"></mjx-c></mjx-mi></mjx-math></mjx-container>"#,
            r#" and diagram <svg viewBox="0 0 1 1"><circle r="1"/></svg>"#,
            r#"<script>alert(1)</script></p>"#
        );
        let out = run(html);
        assert!(out.contains("<mi>𝑥</mi>"), "{out}");
        assert!(out.contains(r#"viewBox="0 0 1 1""#), "{out}");
        assert!(!out.contains("script"), "{out}");
        assert!(!out.contains("onclick"), "{out}");
    }

    #[test]
    fn placeholder_cannot_be_forged() {
        // A feed guessing the placeholder shape gets inert text, never SVG.
        let out = run("<p>inlineph00000000000000000000000000inlineph0000000000000000000000000</p>");
        assert!(out.starts_with("<p>inlineph"), "{out}");
    }

    #[test]
    fn empty_input() {
        assert_eq!(run(""), "");
    }
}
