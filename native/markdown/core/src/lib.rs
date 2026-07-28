//! Markdown → HTML rendering for Lion Reader.
//!
//! One dialect for every Markdown source in the app (uploads, Markdown URL
//! saves, GitHub repo files, AI summaries) — see "Parsing" in the root
//! CLAUDE.md. GitHub Flavored Markdown via comrak, `$…$` / `$$…$$` TeX via
//! pulldown-latex, both budget-checked.
//!
//! ## Why this is native (#1431)
//!
//! The previous renderer (marked + KaTeX) was synchronous, unbounded, and
//! amplified math-dense input ~29x, so a 5 MB Markdown file rendered to ~140 MB
//! of string and ~13 s of event-loop-blocking CPU on the app server *before*
//! anything checked the size. Rust fixes both halves:
//!
//! - the work is ~20x faster and amplifies ~10x rather than ~29x, and
//! - it can be handed to the libuv thread pool (`renderMarkdownAsync`) exactly
//!   like the sanitizer and Readability extractor, so a large body never blocks
//!   the event loop.
//!
//! Both budgets are enforced **inside** the render rather than by the caller:
//! the input cap short-circuits before parsing, and the output cap aborts the
//! formatter mid-write (see [`BudgetWriter`]), so an amplifying document is
//! rejected while it amplifies instead of after it has already built the string.

use std::fmt::{self, Write};
use std::sync::Mutex;

use comrak::adapters::{HeadingAdapter, HeadingMeta};
use comrak::nodes::{AstNode, NodeValue, Sourcepos};
use comrak::options::Plugins;
use comrak::{format_html_with_plugins, parse_document, Anchorizer, Arena, Options};
use pulldown_latex::config::{DisplayMode, RenderConfig};
use pulldown_latex::{push_mathml, Parser, Storage};

/// Byte budgets for a single render. Both are supplied by the caller so the
/// limits stay configurable from `usageLimitsConfig` rather than baked in here.
#[derive(Debug, Clone, Copy)]
pub struct RenderLimits {
    /// Maximum size of the Markdown source, in bytes.
    pub max_input_bytes: usize,
    /// Maximum size of the rendered HTML, in bytes.
    pub max_output_bytes: usize,
}

/// Why a render was rejected. Rendering itself is infallible — malformed
/// Markdown and malformed TeX both degrade to output rather than an error — so
/// a budget is the only way this fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderError {
    /// The Markdown source was larger than `max_input_bytes`.
    InputTooLarge,
    /// The rendered HTML would have been larger than `max_output_bytes`.
    OutputTooLarge,
}

/// A `fmt::Write` sink that refuses to grow past a byte budget.
///
/// comrak streams the document into this, so an amplifying document (a page of
/// `$a_1^2$`, a thousand-row `\begin{matrix}`) stops costing CPU and memory at
/// the budget instead of at the end of the document. `fmt::Write` has no room
/// for a custom error, so the overflow is recorded in `exceeded` and the caller
/// distinguishes it from a genuine formatter error.
struct BudgetWriter {
    out: String,
    limit: usize,
    exceeded: bool,
}

impl BudgetWriter {
    fn new(limit: usize) -> Self {
        BudgetWriter {
            // Only a starting point: a budget can be far larger than any real
            // document, so don't reserve it up front.
            out: String::new(),
            limit,
            exceeded: false,
        }
    }
}

impl Write for BudgetWriter {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        if self.out.len() + s.len() > self.limit {
            self.exceeded = true;
            return Err(fmt::Error);
        }
        self.out.push_str(s);
        Ok(())
    }
}

/// Emits `<h2 id="slug">…</h2>` and nothing else.
///
/// comrak's built-in heading-id rendering also appends a visible
/// `<a class="anchor">` inside every heading, which we don't want; the adapter
/// path skips that markup *and* skips comrak's own anchorizer, so this holds
/// its own. Being per-render (not module-level, the way `marked-gfm-heading-id`
/// kept its slugger) is what makes concurrent documents safe: two renders can
/// never share an occurrence table and slug `Intro` as `intro-1`.
///
/// `Anchorizer` implements GitHub's slugging algorithm, which is the point —
/// a hand-written table of contents (`[Intro](#intro)`) is written against
/// GitHub's rules and has to land (#1425).
struct SluggedHeadings {
    // `HeadingAdapter` is `Send + Sync` and takes `&self`, so the occurrence
    // table needs interior mutability. Uncontended: one render, one thread.
    anchorizer: Mutex<Anchorizer>,
}

impl SluggedHeadings {
    fn new() -> Self {
        SluggedHeadings {
            anchorizer: Mutex::new(Anchorizer::new()),
        }
    }
}

impl HeadingAdapter for SluggedHeadings {
    fn enter(
        &self,
        output: &mut dyn Write,
        heading: &HeadingMeta,
        _sourcepos: Option<Sourcepos>,
    ) -> fmt::Result {
        let id = match self.anchorizer.lock() {
            Ok(mut anchorizer) => anchorizer.anchorize(&heading.content),
            // A poisoned mutex means another heading panicked mid-slug. Emit the
            // heading without an id rather than taking the whole render down.
            Err(_) => String::new(),
        };
        if id.is_empty() {
            return write!(output, "<h{}>", heading.level);
        }
        write!(output, "<h{} id=\"", heading.level)?;
        comrak::html::escape(output, &id)?;
        output.write_str("\">")
    }

    fn exit(&self, output: &mut dyn Write, heading: &HeadingMeta) -> fmt::Result {
        write!(output, "</h{}>", heading.level)
    }
}

/// comrak options pinned to the dialect the whole app renders.
fn options() -> Options<'static> {
    let mut options = Options::default();

    // GitHub Flavored Markdown.
    options.extension.strikethrough = true;
    options.extension.table = true;
    options.extension.autolink = true;
    options.extension.tasklist = true;
    // GFM footnotes: `[^1]` references plus `[^1]:` definitions. Without this,
    // definitions render as literal text inline where they're written (jarring
    // for Pandoc-style uploads and markdown-only pages).
    options.extension.footnotes = true;

    // `$…$` / `$$…$$` TeX. Rendered to MathML in `rewrite_math`, not by
    // comrak's own math renderer (which only escapes the TeX into a
    // `<span data-math-style>` for a client-side renderer to pick up).
    options.extension.math_dollars = true;

    // Treat a single newline as a line break, matching how the Markdown people
    // paste into uploads is usually written.
    options.render.hardbreaks = true;

    // Pass raw HTML through. Markdown sources are untrusted, but sanitization
    // is a *read-path* concern here: entry HTML is stored raw and sanitized on
    // every read (see src/server/html/CLAUDE.md). Stripping it at render time
    // would silently drop legitimate inline HTML from uploads and gain nothing.
    options.render.r#unsafe = true;

    options
}

/// Renders one `$…$` / `$$…$$` span to MathML.
///
/// Malformed TeX must never fail the document (the old KaTeX config used
/// `throwOnError: false` for the same reason): pulldown-latex renders a parse
/// error as an inline `<merror>`, and if it fails outright the raw TeX is
/// emitted as escaped text so the author can still see what they wrote.
fn math_to_mathml(tex: &str, display: bool) -> String {
    let storage = Storage::new();
    let config = RenderConfig {
        display_mode: if display {
            DisplayMode::Block
        } else {
            DisplayMode::Inline
        },
        // No `annotation` (the TeX source): the read-path sanitizer drops
        // `<annotation>` anyway, so emitting one is pure amplification.
        ..Default::default()
    };

    let mut mathml = String::new();
    if push_mathml(&mut mathml, Parser::new(tex, &storage), config).is_ok() {
        return mathml;
    }

    let mut fallback = String::from("<code>");
    // An escape failure here can only be an allocation problem; the partial
    // string is still valid HTML, so there is nothing useful to do about it.
    let _ = comrak::html::escape(&mut fallback, tex);
    fallback.push_str("</code>");
    fallback
}

/// Replaces every math node with its rendered MathML, in place.
///
/// Iterative rather than recursive: node depth follows the document's nesting,
/// which is attacker-controlled, and a recursive walk would meet the stack
/// before it met any budget.
///
/// Counts the MathML it produces against `max_output_bytes` as it goes. The
/// formatter enforces the same budget later, but by then the AST would already
/// be holding every expansion — this stops a math bomb at the budget instead of
/// at the end of the document.
fn rewrite_math<'a>(root: &'a AstNode<'a>, max_output_bytes: usize) -> Result<(), RenderError> {
    let mut budget = max_output_bytes;
    let mut stack = vec![root];

    while let Some(node) = stack.pop() {
        stack.extend(node.children());

        let mut data = node.data.borrow_mut();
        let NodeValue::Math(ref math) = data.value else {
            continue;
        };

        let mathml = math_to_mathml(&math.literal, math.display_math);
        if mathml.len() > budget {
            return Err(RenderError::OutputTooLarge);
        }
        budget -= mathml.len();
        // Raw HTML: `render.unsafe` is on, so this is written through verbatim.
        // Inline rather than block even for `$$…$$` — `<math>` is phrasing
        // content, and `display="block"` already makes it render as a block.
        data.value = NodeValue::HtmlInline(mathml);
    }

    Ok(())
}

/// Renders Markdown to HTML, rejecting anything that breaks a byte budget.
pub fn render(markdown: &str, limits: RenderLimits) -> Result<String, RenderError> {
    if markdown.len() > limits.max_input_bytes {
        return Err(RenderError::InputTooLarge);
    }

    let options = options();
    let arena = Arena::new();
    let root = parse_document(&arena, markdown, &options);
    rewrite_math(root, limits.max_output_bytes)?;

    let headings = SluggedHeadings::new();
    let mut plugins = Plugins::default();
    plugins.render.heading_adapter = Some(&headings);

    let mut writer = BudgetWriter::new(limits.max_output_bytes);
    match format_html_with_plugins(root, &options, &mut writer, &plugins) {
        Ok(()) => Ok(writer.out),
        Err(_) if writer.exceeded => Err(RenderError::OutputTooLarge),
        // `fmt::Write` on a String is infallible otherwise, so this is
        // unreachable in practice; treat it as an over-budget render rather
        // than inventing a third failure mode.
        Err(_) => Err(RenderError::OutputTooLarge),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Budgets far above anything the dialect tests produce.
    const UNLIMITED: RenderLimits = RenderLimits {
        max_input_bytes: 10 * 1024 * 1024,
        max_output_bytes: 10 * 1024 * 1024,
    };

    fn html(markdown: &str) -> String {
        render(markdown, UNLIMITED).expect("render should succeed")
    }

    // ---- dialect ----

    #[test]
    fn renders_gfm_basics() {
        let out = html("~~gone~~ and **bold** and https://auto.link\n");
        assert!(out.contains("<del>gone</del>"), "{out}");
        assert!(out.contains("<strong>bold</strong>"), "{out}");
        assert!(
            out.contains(r#"<a href="https://auto.link">https://auto.link</a>"#),
            "{out}"
        );
    }

    #[test]
    fn renders_tables_and_tasklists() {
        let out = html("| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n");
        assert!(out.contains("<table>"), "{out}");
        assert!(out.contains("<th>a</th>"), "{out}");
        assert!(out.contains(r#"<input type="checkbox" checked="" disabled="" />"#), "{out}");
    }

    #[test]
    fn treats_a_single_newline_as_a_line_break() {
        assert!(html("line one\nline two\n").contains("<br />"));
    }

    #[test]
    fn passes_raw_html_through_for_the_read_path_sanitizer() {
        assert!(html("<div class=\"abstract\">hi</div>\n").contains(r#"<div class="abstract">"#));
    }

    #[test]
    fn renders_footnotes_rather_than_literal_syntax() {
        let out = html("A claim.[^src]\n\n[^src]: The evidence.\n");
        assert!(out.contains("<sup"), "{out}");
        assert!(out.contains(r#"class="footnotes""#), "{out}");
        assert!(out.contains("The evidence."), "{out}");
        assert!(!out.contains("[^src]"), "{out}");
    }

    // ---- headings ----

    #[test]
    fn slugs_headings_the_way_github_does() {
        let out = html("## What's *new* in v2.0?\n");
        assert!(out.contains(r#"<h2 id="whats-new-in-v20">"#), "{out}");
    }

    #[test]
    fn disambiguates_duplicate_headings_within_a_document() {
        let out = html("## Intro\n\nA.\n\n## Intro\n\nB.\n");
        assert!(out.contains(r#"<h2 id="intro">"#), "{out}");
        assert!(out.contains(r#"<h2 id="intro-1">"#), "{out}");
    }

    #[test]
    fn does_not_carry_the_occurrence_table_between_renders() {
        // The bug this guards is why the slugger can't be module-level state:
        // the second document's `Intro` must not become `intro-1`.
        assert!(html("## Intro\n").contains(r#"id="intro""#));
        assert!(html("## Intro\n").contains(r#"id="intro""#));
    }

    #[test]
    fn does_not_add_an_anchor_link_inside_headings() {
        let out = html("## Intro\n");
        assert_eq!(out.trim(), r#"<h2 id="intro">Intro</h2>"#);
    }

    #[test]
    fn omits_the_id_for_a_heading_with_no_sluggable_text() {
        let out = html("## ***\n");
        assert!(out.contains("<h2>"), "{out}");
    }

    // ---- math ----

    #[test]
    fn renders_inline_and_display_tex_as_mathml() {
        let out = html("Mass-energy is $E = mc^2$.\n\n$$\\frac{1}{2}$$\n");
        assert!(out.contains(r#"<math display="inline">"#), "{out}");
        assert!(out.contains("<msup><mi>c</mi><mn>2</mn></msup>"), "{out}");
        assert!(out.contains(r#"<math display="block">"#), "{out}");
        assert!(out.contains("<mfrac>"), "{out}");
        assert!(!out.contains("$$"), "{out}");
    }

    #[test]
    fn does_not_emit_the_tex_source_as_an_annotation() {
        // KaTeX wrapped every expression in `<annotation encoding="application/x-tex">`
        // holding the raw TeX, which the read-path sanitizer then had to drop.
        let out = html("$E = mc^2$\n");
        assert!(!out.contains("<annotation"), "{out}");
        assert!(!out.contains("E = mc^2"), "{out}");
    }

    #[test]
    fn does_not_read_prose_dollar_amounts_as_math() {
        let out = html("It costs $5 and $10 today.\n");
        assert!(out.contains("It costs $5 and $10 today."), "{out}");
        assert!(!out.contains("<math"), "{out}");
    }

    #[test]
    fn degrades_malformed_tex_instead_of_failing_the_document() {
        let out = html("Broken: $\\badcmd{x}$ and text after.\n");
        assert!(out.contains("text after"), "{out}");
    }

    // ---- budgets ----

    #[test]
    fn rejects_input_over_the_byte_cap() {
        let limits = RenderLimits {
            max_input_bytes: 8,
            max_output_bytes: UNLIMITED.max_output_bytes,
        };
        assert_eq!(render("more than eight bytes", limits), Err(RenderError::InputTooLarge));
        assert!(render("tiny", limits).is_ok());
    }

    #[test]
    fn measures_the_input_cap_in_bytes_not_characters() {
        let limits = |max_input_bytes| RenderLimits {
            max_input_bytes,
            max_output_bytes: UNLIMITED.max_output_bytes,
        };
        // "¢¢" is two characters but four bytes: it fits a 4-byte cap exactly
        // and busts a 3-byte one. A character-counting cap would accept both.
        assert!(render("¢¢", limits(4)).is_ok());
        assert_eq!(render("¢¢", limits(3)), Err(RenderError::InputTooLarge));
    }

    #[test]
    fn rejects_output_over_the_byte_budget() {
        let limits = RenderLimits {
            max_input_bytes: UNLIMITED.max_input_bytes,
            max_output_bytes: 32,
        };
        let markdown = "a paragraph that is comfortably longer than the budget allows\n";
        assert_eq!(render(markdown, limits), Err(RenderError::OutputTooLarge));
    }

    #[test]
    fn stops_an_amplifying_math_document_at_the_budget() {
        // The shape from #1431: input well inside the input cap that KaTeX blew
        // up ~29x. It must be rejected for the *output* it would produce.
        let markdown = "$a_1^2$ ".repeat(2000);
        let limits = RenderLimits {
            max_input_bytes: UNLIMITED.max_input_bytes,
            max_output_bytes: markdown.len(),
        };
        assert_eq!(render(&markdown, limits), Err(RenderError::OutputTooLarge));
    }

    #[test]
    fn accepts_a_document_that_exactly_fits_its_budget() {
        let markdown = "hello\n";
        let rendered = html(markdown);
        let limits = RenderLimits {
            max_input_bytes: UNLIMITED.max_input_bytes,
            max_output_bytes: rendered.len(),
        };
        assert_eq!(render(markdown, limits), Ok(rendered));
    }

    #[test]
    fn survives_deeply_nested_input_without_overflowing_the_stack() {
        // The math walk is iterative because nesting depth is author-controlled.
        let markdown = "> ".repeat(20_000) + "$x$";
        // Either outcome is fine; crashing the process is not.
        let _ = render(&markdown, UNLIMITED);
    }
}
