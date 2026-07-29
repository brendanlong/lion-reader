//! Markdown → HTML rendering for Lion Reader.
//!
//! One dialect for every Markdown source in the app (uploads, Markdown URL
//! saves, GitHub repo files, AI summaries) — see "Parsing" in the root
//! CLAUDE.md. GitHub Flavored Markdown via comrak, `$…$` / `$$…$$` TeX via
//! pulldown-latex, both budget-checked.
//!
//! ## Budgets (#1431)
//!
//! Rendering **amplifies** — math-dense input grows several times over — so
//! both byte budgets are enforced *inside* the render rather than by the
//! caller: the input cap short-circuits before parsing, and the output cap
//! aborts the formatter mid-write (see [`BudgetWriter`]), so an amplifying
//! document is rejected while it amplifies instead of after it has built the
//! whole string. [`MAX_TEX_NESTING_DEPTH`] covers the one cost bytes can't see.
//!
//! Being native is also what lets a render be handed to the libuv thread pool
//! (`renderMarkdownAsync`), the way the sanitizer and Readability extractor
//! already are, so a large document never blocks the event loop.

use std::convert::Infallible;
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
/// the budget instead of at the end of the document.
///
/// Overflow is the only way writing can fail — `fmt::Write` on a `String` is
/// otherwise infallible — so the `fmt::Error` needs no extra discriminator.
struct BudgetWriter {
    out: String,
    limit: usize,
}

impl BudgetWriter {
    fn new(limit: usize) -> Self {
        BudgetWriter {
            // Only a starting point: a budget can be far larger than any real
            // document, so don't reserve it up front.
            out: String::new(),
            limit,
        }
    }
}

impl Write for BudgetWriter {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        if self.out.len() + s.len() > self.limit {
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
/// its own. Being per-render state is what makes concurrent documents safe: two
/// renders can never share an occurrence table and slug `Intro` as `intro-1`.
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
        // The mutex never escapes `render`, so a panic in `anchorize` unwinds
        // out of the whole render rather than leaving a poisoned lock for a
        // later heading to trip on — recovering the guard is the honest arm.
        let mut anchorizer = self.anchorizer.lock().unwrap_or_else(|e| e.into_inner());
        let id = anchorizer.anchorize(&heading.content);
        drop(anchorizer);
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

/// Maximum group nesting depth of a single TeX expression.
///
/// pulldown-latex is **quadratic in nesting depth** — measured on
/// `$$\frac{1}{\frac{1}{…}}$$`, depth 1k/2k/4k/8k/16k costs 17/66/268/1060/4351
/// ms — and neither budget can stop it, because the cost is paid inside one
/// `push_mathml` call that produces a *small* result. A 1 MB document of
/// `$${{{{…}}}}$$` would pin a thread-pool thread for minutes, which is worse
/// than the event-loop stall #1431 set out to fix (and harder to see, since it
/// no longer shows up as event-loop delay).
///
/// Real math is nowhere near this: KaTeX's own test corpus tops out in the low
/// tens, so anything past this cap is a bomb, not a document. Over-deep TeX
/// degrades to escaped source like any other TeX we can't render.
const MAX_TEX_NESTING_DEPTH: usize = 64;

/// Deepest group nesting in a TeX expression.
///
/// Deliberately over-counts rather than under-counts (`\begin{matrix}` scores
/// both its `\begin` and its braces): this is a safety cap, so guessing high is
/// the harmless direction. Works on bytes so a multi-byte character after a
/// backslash can't split a `char` boundary.
fn tex_nesting_depth(tex: &str) -> usize {
    let bytes = tex.as_bytes();
    let mut depth: i32 = 0;
    let mut deepest: i32 = 0;
    let mut i = 0;

    while i < bytes.len() {
        let rest = &bytes[i..];
        let step = if rest[0] == b'\\' {
            if rest.starts_with(br"\left") || rest.starts_with(br"\begin") {
                depth += 1;
            } else if rest.starts_with(br"\right") || rest.starts_with(br"\end") {
                depth -= 1;
            }
            // Skip the escaped character too, so `\{` and `\}` (literal braces,
            // not grouping) don't count.
            2
        } else {
            match rest[0] {
                b'{' => depth += 1,
                b'}' => depth -= 1,
                _ => {}
            }
            1
        };
        deepest = deepest.max(depth);
        i += step;
    }

    deepest.max(0) as usize
}

/// The TeX source, escaped, as a `<code>` element.
///
/// What every expression we can't render degrades to — the author still sees
/// what they wrote, in the shape of the thing it is.
fn escaped_tex(tex: &str) -> String {
    let mut fallback = String::from("<code>");
    // An escape failure here can only be an allocation problem; the partial
    // string is still valid HTML, so there is nothing useful to do about it.
    let _ = comrak::html::escape(&mut fallback, tex);
    fallback.push_str("</code>");
    fallback
}

/// Renders one `$…$` / `$$…$$` span to MathML.
///
/// Malformed TeX must never fail the document, so anything unrenderable — a
/// parse error, an unsupported macro, nesting past [`MAX_TEX_NESTING_DEPTH`] —
/// degrades to [`escaped_tex`].
///
/// The parse is deliberately run to completion **before** rendering rather than
/// streamed into `push_mathml`, because pulldown-latex's own error rendering
/// writes the offending TeX into `<mtext>` **unescaped** (`mathml.rs`, the
/// `Err(e)` arm of `write_event`). Since `render.unsafe` passes our output
/// through verbatim, a `$\badcmd{<style>x}$` would inject a live element into
/// the article — and the read-path sanitizer, doing exactly what it should with
/// an unclosed `<style>`, would drop the entire rest of the entry. Handling the
/// error ourselves means no attacker-controlled bytes ever reach the output
/// except through `escape`.
fn math_to_mathml(tex: &str, display: bool) -> String {
    if tex_nesting_depth(tex) > MAX_TEX_NESTING_DEPTH {
        return escaped_tex(tex);
    }

    let storage = Storage::new();
    let Ok(events) = Parser::new(tex, &storage).collect::<Result<Vec<_>, _>>() else {
        return escaped_tex(tex);
    };

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
    match push_mathml(&mut mathml, events.into_iter().map(Ok::<_, Infallible>), config) {
        Ok(()) => mathml,
        Err(_) => escaped_tex(tex),
    }
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
        // The reader CSS styles the checkbox via `li > input:first-child` (it has
        // to replace the bullet), so the checkbox being a *direct, leading* child
        // of the `<li>` is a contract, not an incidental detail of comrak's
        // output — a version bump that nests it would silently unstyle every
        // task list with the assertion above still green.
        assert!(
            out.contains(r#"<li><input type="checkbox" checked="" disabled="" /> done</li>"#),
            "{out}"
        );
        // Alignment rows land on the cells, which the sanitizer allow-lists.
        let aligned = html("| a | b |\n| :-: | --: |\n| 1 | 2 |\n");
        assert!(aligned.contains(r#"<th align="center">a</th>"#), "{aligned}");
        assert!(aligned.contains(r#"<th align="right">b</th>"#), "{aligned}");
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
        // An `<annotation>` holding the TeX source would be pure amplification:
        // the read-path sanitizer drops it.
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
        assert!(out.contains("<code>"), "{out}");
    }

    #[test]
    fn never_emits_unescaped_tex_from_a_failed_render() {
        // pulldown-latex's own error rendering writes the offending TeX into
        // `<mtext>` unescaped, and `render.unsafe` would pass that through. The
        // injected element below reached the read-path sanitizer as an unclosed
        // `<style>`, which correctly dropped the entire rest of the entry.
        let out = html("$\\badcmd{<style>x}$\n\nA later paragraph.\n");
        assert!(!out.contains("<style>"), "{out}");
        assert!(out.contains("&lt;style&gt;"), "{out}");
        assert!(out.contains("A later paragraph."), "{out}");
    }

    #[test]
    fn escapes_tex_that_closes_its_own_container() {
        // `<b` is not an attack, just an unsupported macro next to a `<`
        // comparison — the shape that makes this reachable by accident.
        let out = html("$\\bm{a}<b$\n");
        assert!(!out.contains("<b>"), "{out}");
        assert!(out.contains("&lt;b"), "{out}");
    }

    // ---- TeX nesting depth ----

    #[test]
    fn counts_nesting_depth_without_counting_escaped_braces() {
        assert_eq!(tex_nesting_depth("x"), 0);
        assert_eq!(tex_nesting_depth("\\frac{1}{2}"), 1);
        assert_eq!(tex_nesting_depth("\\frac{\\frac{1}{2}}{3}"), 2);
        assert_eq!(tex_nesting_depth("\\left(x\\right)"), 1);
        // `\{` and `\}` are literal braces, not grouping.
        assert_eq!(tex_nesting_depth("\\{x\\}"), 0);
        // A multi-byte character right after a backslash must not panic.
        assert_eq!(tex_nesting_depth("\\¢{x}"), 1);
    }

    #[test]
    fn degrades_tex_nested_past_the_depth_cap() {
        let deep = format!(
            "${}x{}$",
            "\\frac{1}{".repeat(MAX_TEX_NESTING_DEPTH + 1),
            "}".repeat(MAX_TEX_NESTING_DEPTH + 1)
        );
        let out = html(&deep);
        assert!(out.contains("<code>"), "{out}");
        assert!(!out.contains("<math"), "{out}");
    }

    #[test]
    fn still_renders_tex_at_the_depth_cap() {
        // The cap must sit far above real math, not clip it.
        let deep = format!("${}x{}$", "\\frac{1}{".repeat(20), "}".repeat(20));
        assert!(html(&deep).contains("<math"), "depth 20 must still render");
    }

    #[test]
    fn does_not_spend_quadratic_time_on_deeply_nested_tex() {
        // pulldown-latex is quadratic in nesting depth and the budgets can't see
        // it: the cost is paid inside one call that returns a *small* result.
        // Unguarded, this input took ~180 s (#1431 review). Not a wall-clock
        // assertion — the point is that it completes at all.
        let bomb = format!("${}x{}$", "\\frac{1}{".repeat(100_000), "}".repeat(100_000));
        assert!(html(&bomb).contains("<code>"));
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
