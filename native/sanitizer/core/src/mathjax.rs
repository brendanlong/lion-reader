//! Convert MathJax v3 CommonHTML (CHTML) output back into presentation
//! MathML — direct port of `src/server/html/mathjax-chtml.ts`.
//!
//! Sources like LessWrong deliver math pre-rendered as a tree of custom
//! `<mjx-*>` elements where each glyph is an *empty* `<mjx-c class="mjx-c1D465">`
//! whose character is encoded in the class name (`mjx-c1D465` → U+1D465 `𝑥`).
//! The sanitizer drops `<mjx-*>` and `<style>`, so without this transform the
//! math vanishes. MathML is on the allow-list and renders natively, so the
//! CHTML tree is rewritten to MathML before sanitization. When the container
//! carries MathJax's assistive MathML (`<mjx-assistive-mml>`), that exact
//! MathML is used verbatim — it is the ground truth the CHTML was rendered
//! from. Otherwise the tree is reconstructed structurally from the semantic
//! `<mjx-*>` wrapper names (verified against mathjax-full 3.2.2 output);
//! unrecognized wrappers are unwrapped (lossy but readable) and reported via
//! `warnings` so MathJax layout drift is noticed.
//!
//! Only the located `<mjx-container>` substrings are parsed into a DOM
//! (issue #1054); everything outside them is spliced through verbatim.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;
use scraper::{ElementRef, Html, Node};

use crate::scanner::{find_top_level_ranges, Recovery};
use crate::serialize::{serialize_mnodes, serialize_subtree, MNode};

const MATHML_NS: &str = "http://www.w3.org/1998/Math/MathML";

/// MathJax token elements → MathML token elements: these hold the actual
/// glyphs, so their characters are flattened into text content.
fn token_tag(tag: &str) -> Option<&'static str> {
    match tag {
        "mjx-mi" => Some("mi"),
        "mjx-mo" => Some("mo"),
        "mjx-mn" => Some("mn"),
        "mjx-ms" => Some("ms"),
        "mjx-mtext" => Some("mtext"),
        _ => None,
    }
}

/// Layout-only wrappers whose children are unwrapped in place without being
/// reported as unknown.
const KNOWN_LAYOUT_TAGS: &[&str] = &[
    "mjx-texatom", "mjx-mrow", "mjx-mstyle", "mjx-mpadded", "mjx-box", "mjx-row", "mjx-block",
    "mjx-spacer", "mjx-strut", "mjx-nstrut", "mjx-dstrut", "mjx-tstrut", "mjx-line", "mjx-mark",
];

struct ConvertContext {
    unknown_tags: BTreeSet<String>,
}

static CODEPOINT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bmjx-c([0-9A-Fa-f]{2,6})\b").unwrap());

static MSPACE_WIDTH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"width:\s*([^;]+)").unwrap());

/// The Unicode character a glyph element represents, from its `mjx-c<HEX>`
/// class. Surrogate codepoints are rejected (`char::from_u32` refuses them
/// by construction, matching the TS guard against ill-formed output).
fn codepoint_char(el: ElementRef) -> String {
    let class = el.value().attr("class").unwrap_or("");
    let Some(captures) = CODEPOINT_RE.captures(class) else {
        return String::new();
    };
    let Ok(codepoint) = u32::from_str_radix(&captures[1], 16) else {
        return String::new();
    };
    char::from_u32(codepoint).map(String::from).unwrap_or_default()
}

/// Concatenated text of all descendant text nodes.
fn text_content(el: ElementRef) -> String {
    let mut out = String::new();
    for node in el.descendants() {
        if let Node::Text(text) = node.value() {
            out.push_str(text);
        }
    }
    out
}

/// Collect the text of a token element in document order: `<mjx-c>` glyphs
/// decode from their class codepoint, `<mjx-utext>` contributes real text,
/// and stretchy assemblies carry the real codepoint class on the stretchy
/// element itself (their `<mjx-c>` pieces are classless).
fn token_text(el: ElementRef) -> String {
    fn walk(node: ElementRef, text: &mut String) {
        for child in node.children() {
            let Some(child_el) = ElementRef::wrap(child) else {
                continue;
            };
            match child_el.value().name() {
                "mjx-c" => text.push_str(&codepoint_char(child_el)),
                "mjx-utext" => text.push_str(&text_content(child_el)),
                "mjx-stretchy-v" | "mjx-stretchy-h" => text.push_str(&codepoint_char(child_el)),
                _ => walk(child_el, text),
            }
        }
    }
    let mut text = String::new();
    walk(el, &mut text);
    text
}

fn element_children(el: ElementRef<'_>) -> impl Iterator<Item = ElementRef<'_>> {
    el.children().filter_map(ElementRef::wrap)
}

fn convert_children(parent: ElementRef, ctx: &mut ConvertContext, out: &mut Vec<MNode>) {
    for child in element_children(parent) {
        convert_element(child, ctx, out);
    }
}

/// Wrap a node list as a single MathML node (an <mrow> when 0 or >1).
fn group_nodes(mut nodes: Vec<MNode>) -> MNode {
    if nodes.len() == 1 {
        nodes.pop().unwrap()
    } else {
        MNode::elem("mrow", nodes)
    }
}

fn convert_group(parent: Option<ElementRef>, ctx: &mut ConvertContext) -> MNode {
    let mut nodes = Vec::new();
    if let Some(parent) = parent {
        convert_children(parent, ctx, &mut nodes);
    }
    group_nodes(nodes)
}

/// First descendant element (any depth, excluding self) with the given name.
fn first_descendant<'a>(el: ElementRef<'a>, name: &str) -> Option<ElementRef<'a>> {
    el.descendants()
        .filter(|n| n.id() != el.id())
        .filter_map(ElementRef::wrap)
        .find(|candidate| candidate.value().name() == name)
}

/// Numerator/denominator wrappers of a single `<mjx-mfrac>`, descending
/// through layout wrappers but stopping at this fraction's own parts and at
/// nested fractions (whose parts are not ours).
fn find_fraction_parts(frac: ElementRef) -> (Option<ElementRef>, Option<ElementRef>) {
    fn visit<'a>(
        node: ElementRef<'a>,
        num: &mut Option<ElementRef<'a>>,
        den: &mut Option<ElementRef<'a>>,
    ) {
        for child in element_children(node) {
            match child.value().name() {
                "mjx-num" => {
                    num.get_or_insert(child);
                }
                "mjx-den" => {
                    den.get_or_insert(child);
                }
                "mjx-mfrac" => {}
                _ => visit(child, num, den),
            }
        }
    }
    let (mut num, mut den) = (None, None);
    visit(frac, &mut num, &mut den);
    (num, den)
}

/// `<mjx-base>` / `<mjx-over>` / `<mjx-under>` parts of an over/under-script
/// element, descending through composition wrappers but never into a found
/// part.
fn find_script_parts(
    el: ElementRef,
) -> (Option<ElementRef>, Option<ElementRef>, Option<ElementRef>) {
    const LAYOUT: &[&str] = &["mjx-row", "mjx-box", "mjx-munder", "mjx-mover", "mjx-munderover"];
    fn visit<'a>(
        node: ElementRef<'a>,
        base: &mut Option<ElementRef<'a>>,
        over: &mut Option<ElementRef<'a>>,
        under: &mut Option<ElementRef<'a>>,
    ) {
        for child in element_children(node) {
            match child.value().name() {
                "mjx-base" => {
                    base.get_or_insert(child);
                }
                "mjx-over" => {
                    over.get_or_insert(child);
                }
                "mjx-under" => {
                    under.get_or_insert(child);
                }
                name if LAYOUT.contains(&name) => visit(child, base, over, under),
                _ => {}
            }
        }
    }
    let (mut base, mut over, mut under) = (None, None, None);
    visit(el, &mut base, &mut over, &mut under);
    (base, over, under)
}

/// Split an `<mjx-script>`'s children into the groups separated by
/// `<mjx-spacer>` (msubsup stacks sup then sub; script-layout munderover
/// stacks over then under).
fn split_script_groups(script: ElementRef, ctx: &mut ConvertContext) -> Vec<Vec<MNode>> {
    let mut groups: Vec<Vec<MNode>> = vec![Vec::new()];
    for child in element_children(script) {
        if child.value().name() == "mjx-spacer" {
            groups.push(Vec::new());
        } else {
            let last = groups.last_mut().unwrap();
            convert_element(child, ctx, last);
        }
    }
    groups
}

/// Partition a scripted element's children into base nodes and its
/// `<mjx-script>` child.
fn partition_script<'a>(
    el: ElementRef<'a>,
    ctx: &mut ConvertContext,
) -> (Vec<MNode>, Option<ElementRef<'a>>) {
    let mut base_nodes = Vec::new();
    let mut script = None;
    for child in element_children(el) {
        if child.value().name() == "mjx-script" {
            script = Some(child);
        } else {
            convert_element(child, ctx, &mut base_nodes);
        }
    }
    (base_nodes, script)
}

/// `<mjx-mtable><mjx-table><mjx-itable><mjx-mtr><mjx-mtd>…` →
/// `<mtable><mtr><mtd>…`, descending through the layout wrappers.
fn convert_table(el: ElementRef, ctx: &mut ConvertContext) -> MNode {
    fn visit_rows(node: ElementRef, ctx: &mut ConvertContext, rows: &mut Vec<MNode>) {
        for child in element_children(node) {
            let name = child.value().name();
            if name == "mjx-mtr" || name == "mjx-mlabeledtr" {
                let mut cells = Vec::new();
                for cell in element_children(child) {
                    if cell.value().name() == "mjx-mtd" {
                        cells.push(MNode::elem("mtd", vec![convert_group(Some(cell), ctx)]));
                    }
                }
                rows.push(MNode::elem("mtr", cells));
            } else if name == "mjx-mtable" || token_tag(name).is_some() {
                // A nested table or content element belongs to a cell, not to
                // us — only descend through this table's own layout wrappers.
            } else {
                visit_rows(child, ctx, rows);
            }
        }
    }
    let mut rows = Vec::new();
    visit_rows(el, ctx, &mut rows);
    MNode::elem("mtable", rows)
}

fn convert_element(el: ElementRef, ctx: &mut ConvertContext, out: &mut Vec<MNode>) {
    let tag = el.value().name();

    if tag == "mjx-c" {
        out.push(MNode::Text(codepoint_char(el)));
        return;
    }

    // Characters outside the MathJax fonts (CJK, etc.) carry real text.
    if tag == "mjx-utext" {
        out.push(MNode::Text(text_content(el)));
        return;
    }

    if let Some(token) = token_tag(tag) {
        out.push(MNode::elem(token, vec![MNode::Text(token_text(el))]));
        return;
    }

    // texatom and mrow are plain horizontal groupings.
    if tag == "mjx-texatom" || tag == "mjx-mrow" {
        out.push(convert_group(Some(el), ctx));
        return;
    }

    // Explicit spacing (\quad, \, …): the width lives in the inline style.
    if tag == "mjx-mspace" {
        let width = el
            .value()
            .attr("style")
            .and_then(|style| MSPACE_WIDTH_RE.captures(style))
            .map(|captures| captures[1].trim().to_string());
        let attrs = width.map(|w| vec![("width".to_string(), w)]).unwrap_or_default();
        out.push(MNode::elem_with_attrs("mspace", attrs, Vec::new()));
        return;
    }

    // Sub/superscripts: CHTML lays out [base …, <mjx-script>]; msubsup's
    // script stacks sup then sub, separated by <mjx-spacer>.
    if tag == "mjx-msup" || tag == "mjx-msub" || tag == "mjx-msubsup" {
        let (base_nodes, script) = partition_script(el, ctx);
        let groups = script.map(|s| split_script_groups(s, ctx)).unwrap_or_default();
        if tag == "mjx-msubsup" && groups.len() >= 2 {
            let mut groups = groups.into_iter();
            let sup = groups.next().unwrap(); // stacked above
            let sub = groups.next().unwrap(); // stacked below
            out.push(MNode::elem(
                "msubsup",
                vec![group_nodes(base_nodes), group_nodes(sub), group_nodes(sup)],
            ));
            return;
        }
        let name = match tag {
            "mjx-msup" => "msup",
            "mjx-msub" => "msub",
            _ => "msubsup",
        };
        let mut children = vec![group_nodes(base_nodes)];
        children.extend(groups.into_iter().map(group_nodes));
        out.push(MNode::elem(name, children));
        return;
    }

    // Over/under scripts: named part wrappers (possibly nested in
    // composition wrappers), or the [base, <mjx-script>] layout for inline
    // operators with limits="false".
    if tag == "mjx-mover" || tag == "mjx-munder" || tag == "mjx-munderover" {
        let (base, over, under) = find_script_parts(el);
        if base.is_none() && over.is_none() && under.is_none() {
            let (base_nodes, script) = partition_script(el, ctx);
            let groups = script.map(|s| split_script_groups(s, ctx)).unwrap_or_default();
            if tag == "mjx-munderover" && groups.len() >= 2 {
                let mut groups = groups.into_iter();
                let over_g = groups.next().unwrap(); // stacked above
                let under_g = groups.next().unwrap(); // stacked below
                out.push(MNode::elem(
                    "munderover",
                    vec![group_nodes(base_nodes), group_nodes(under_g), group_nodes(over_g)],
                ));
                return;
            }
            let name = match tag {
                "mjx-mover" => "mover",
                "mjx-munder" => "munder",
                _ => "munderover",
            };
            let mut children = vec![group_nodes(base_nodes)];
            children.extend(groups.into_iter().map(group_nodes));
            out.push(MNode::elem(name, children));
            return;
        }
        let mut children = vec![convert_group(base, ctx)];
        match tag {
            "mjx-munder" => children.push(convert_group(under, ctx)),
            "mjx-mover" => children.push(convert_group(over, ctx)),
            _ => {
                children.push(convert_group(under, ctx));
                children.push(convert_group(over, ctx));
            }
        }
        let name = match tag {
            "mjx-mover" => "mover",
            "mjx-munder" => "munder",
            _ => "munderover",
        };
        out.push(MNode::elem(name, children));
        return;
    }

    // Fractions: scoped part lookup so a nested fraction's parts aren't
    // grabbed by document order.
    if tag == "mjx-mfrac" {
        let (num, den) = find_fraction_parts(el);
        if let (Some(num), Some(den)) = (num, den) {
            out.push(MNode::elem(
                "mfrac",
                vec![convert_group(Some(num), ctx), convert_group(Some(den), ctx)],
            ));
            return;
        }
        convert_children(el, ctx, out);
        return;
    }

    // Square roots: radicand in <mjx-box>, radical glyph in <mjx-surd>.
    if tag == "mjx-msqrt" || tag == "mjx-sqrt" {
        if let Some(radicand) = first_descendant(el, "mjx-box") {
            out.push(MNode::elem("msqrt", vec![convert_group(Some(radicand), ctx)]));
            return;
        }
        convert_children(el, ctx, out);
        return;
    }

    // Roots with an index; MathML order is (base, index).
    if tag == "mjx-mroot" {
        let index = first_descendant(el, "mjx-root");
        let radicand = first_descendant(el, "mjx-box");
        if let (Some(index), Some(radicand)) = (index, radicand) {
            out.push(MNode::elem(
                "mroot",
                vec![convert_group(Some(radicand), ctx), convert_group(Some(index), ctx)],
            ));
            return;
        }
        convert_children(el, ctx, out);
        return;
    }

    // Tables (matrices, cases, aligned environments).
    if tag == "mjx-mtable" {
        out.push(convert_table(el, ctx));
        return;
    }

    // The radical glyph is drawn by MathML itself; drop the CHTML one.
    if tag == "mjx-surd" {
        return;
    }

    // Known layout-only wrappers: unwrap silently.
    if KNOWN_LAYOUT_TAGS.contains(&tag) {
        convert_children(el, ctx, out);
        return;
    }

    // Unknown <mjx-*> wrapper: unwrap so its inner tokens still render, and
    // record it — this is the canary for MathJax layout drift.
    if tag.starts_with("mjx-") {
        ctx.unknown_tags.insert(tag.to_string());
        convert_children(el, ctx, out);
        return;
    }

    // A stray non-MathJax element inside the math tree: drop it.
}

/// The `<math>` inside a container's `<mjx-assistive-mml>`, if present.
fn find_assistive_math<'a>(container: ElementRef<'a>) -> Option<ElementRef<'a>> {
    let assistive = first_descendant(container, "mjx-assistive-mml")?;
    element_children(assistive).find(|child| child.value().name() == "math")
}

/// Convert one parsed `<mjx-container>` element to a MathML string. Returns
/// "" when the container carries no math (so the caller drops it).
fn convert_container_element(container: ElementRef, ctx: &mut ConvertContext) -> String {
    // Prefer MathJax's own assistive MathML — the exact MathML the CHTML was
    // rendered from, strictly better than reconstruction.
    if let Some(assistive) = find_assistive_math(container) {
        let mut out = String::new();
        serialize_subtree(assistive, &[("xmlns", MATHML_NS)], &mut out);
        return out;
    }

    let Some(source) = first_descendant(container, "mjx-math") else {
        // Nothing to convert; drop the container rather than leaving a shell.
        return String::new();
    };

    let mut nodes = Vec::new();
    convert_children(source, ctx, &mut nodes);
    let is_display = container.value().attr("display") == Some("true")
        || source.value().attr("display") == Some("true");
    let mut out = if is_display {
        format!(r#"<math xmlns="{MATHML_NS}" display="block">"#)
    } else {
        format!(r#"<math xmlns="{MATHML_NS}">"#)
    };
    serialize_mnodes(&nodes, &mut out);
    out.push_str("</math>");
    out
}

/// The first `mjx-container` element in a parsed fragment.
fn find_container(fragment: &Html) -> Option<ElementRef<'_>> {
    fragment
        .tree
        .root()
        .descendants()
        .filter_map(ElementRef::wrap)
        .find(|el| el.value().name() == "mjx-container")
}

/// Convert any `<mjx-container>` blocks in `html` to presentation MathML.
/// Returns None when the input is unchanged (no CHTML present — the common
/// case, a cheap substring check). Unrecognized `mjx-*` wrapper names are
/// appended to `warnings`.
pub fn convert_mathjax_chtml(html: &str, warnings: &mut Vec<String>) -> Option<String> {
    if !html.contains("<mjx-container") {
        return None;
    }
    let ranges = find_top_level_ranges(
        html,
        "mjx-container",
        &["mjx-math", "mjx-assistive-mml"],
        true,
        Recovery::AtLastInnerClose,
    );
    if ranges.is_empty() {
        return None;
    }

    let mut ctx = ConvertContext { unknown_tags: BTreeSet::new() };
    let mut result = String::with_capacity(html.len());
    let mut cursor = 0usize;
    let mut converted = false;

    for range in &ranges {
        let substring = &html[range.start..range.end];
        let fragment = Html::parse_fragment(substring);
        // The located range must actually parse to a container (the scanner
        // is not a tree builder); otherwise splice it through verbatim.
        let Some(container) = find_container(&fragment) else {
            continue;
        };
        result.push_str(&html[cursor..range.start]);
        result.push_str(&convert_container_element(container, &mut ctx));
        // An unclosed container absorbed real article content: everything
        // past the last explicit math close is spliced back verbatim (its
        // residual mjx-* markup, if any, is stripped by the sanitize pass).
        if range.recover_from < range.end {
            result.push_str(&html[range.recover_from..range.end]);
        }
        cursor = range.end;
        converted = true;
    }

    if !converted {
        return None;
    }
    result.push_str(&html[cursor..]);

    if !ctx.unknown_tags.is_empty() {
        let tags: Vec<&str> = ctx.unknown_tags.iter().map(String::as_str).collect();
        warnings.push(format!(
            "Unwrapped unrecognized MathJax CHTML wrappers during MathML conversion: {}",
            tags.join(", ")
        ));
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn convert(html: &str) -> String {
        let mut warnings = Vec::new();
        convert_mathjax_chtml(html, &mut warnings).unwrap_or_else(|| html.to_string())
    }

    #[test]
    fn no_op_without_containers() {
        let html = "<p>no math here</p>";
        let mut warnings = Vec::new();
        assert!(convert_mathjax_chtml(html, &mut warnings).is_none());
    }

    #[test]
    fn converts_simple_identifier() {
        let html = r#"<p>x is <mjx-container class="MathJax"><mjx-math><mjx-mi><mjx-c class="mjx-c1D465"></mjx-c></mjx-mi></mjx-math></mjx-container>.</p>"#;
        assert_eq!(
            convert(html),
            format!(r#"<p>x is <math xmlns="{MATHML_NS}"><mi>𝑥</mi></math>.</p>"#)
        );
    }

    #[test]
    fn prefers_assistive_mathml() {
        let html = r#"<mjx-container><mjx-math><mjx-mi><mjx-c class="mjx-c1D465"></mjx-c></mjx-mi></mjx-math><mjx-assistive-mml><math><mi>x</mi></math></mjx-assistive-mml></mjx-container>"#;
        assert_eq!(
            convert(html),
            format!(r#"<math xmlns="{MATHML_NS}"><mi>x</mi></math>"#)
        );
    }

    #[test]
    fn display_mode_from_container() {
        let html = r#"<mjx-container display="true"><mjx-math><mjx-mn><mjx-c class="mjx-c31"></mjx-c></mjx-mn></mjx-math></mjx-container>"#;
        assert_eq!(
            convert(html),
            format!(r#"<math xmlns="{MATHML_NS}" display="block"><mn>1</mn></math>"#)
        );
    }

    #[test]
    fn fraction_with_nested_fraction() {
        // Outer fraction whose numerator contains a nested fraction — the
        // scoped part lookup must not grab the nested fraction's parts.
        let html = concat!(
            r#"<mjx-container><mjx-math><mjx-mfrac><mjx-frac>"#,
            r#"<mjx-num><mjx-mfrac><mjx-frac><mjx-num><mjx-mn><mjx-c class="mjx-c31"></mjx-c></mjx-mn></mjx-num>"#,
            r#"<mjx-den><mjx-mn><mjx-c class="mjx-c32"></mjx-c></mjx-mn></mjx-den></mjx-frac></mjx-mfrac></mjx-num>"#,
            r#"<mjx-den><mjx-mn><mjx-c class="mjx-c33"></mjx-c></mjx-mn></mjx-den>"#,
            r#"</mjx-frac></mjx-mfrac></mjx-math></mjx-container>"#
        );
        assert_eq!(
            convert(html),
            format!(
                r#"<math xmlns="{MATHML_NS}"><mfrac><mfrac><mn>1</mn><mn>2</mn></mfrac><mn>3</mn></mfrac></math>"#
            )
        );
    }

    #[test]
    fn msubsup_reorders_stacked_scripts() {
        // Script stacks sup (2) above sub (i), separated by mjx-spacer;
        // MathML order is base, sub, sup.
        let html = concat!(
            r#"<mjx-container><mjx-math><mjx-msubsup>"#,
            r#"<mjx-mi><mjx-c class="mjx-c1D465"></mjx-c></mjx-mi>"#,
            r#"<mjx-script><mjx-mn><mjx-c class="mjx-c32"></mjx-c></mjx-mn>"#,
            r#"<mjx-spacer></mjx-spacer>"#,
            r#"<mjx-mi><mjx-c class="mjx-c1D456"></mjx-c></mjx-mi></mjx-script>"#,
            r#"</mjx-msubsup></mjx-math></mjx-container>"#
        );
        assert_eq!(
            convert(html),
            format!(
                r#"<math xmlns="{MATHML_NS}"><msubsup><mi>𝑥</mi><mi>𝑖</mi><mn>2</mn></msubsup></math>"#
            )
        );
    }

    #[test]
    fn surrogate_codepoint_class_rejected() {
        let html = r#"<mjx-container><mjx-math><mjx-mi><mjx-c class="mjx-cD800"></mjx-c></mjx-mi></mjx-math></mjx-container>"#;
        assert_eq!(
            convert(html),
            format!(r#"<math xmlns="{MATHML_NS}"><mi></mi></math>"#)
        );
    }

    #[test]
    fn unknown_wrapper_unwrapped_and_reported() {
        let html = r#"<mjx-container><mjx-math><mjx-future><mjx-mi><mjx-c class="mjx-c31"></mjx-c></mjx-mi></mjx-future></mjx-math></mjx-container>"#;
        let mut warnings = Vec::new();
        let out = convert_mathjax_chtml(html, &mut warnings).unwrap();
        assert_eq!(out, format!(r#"<math xmlns="{MATHML_NS}"><mi>1</mi></math>"#));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("mjx-future"));
    }

    #[test]
    fn container_only_in_comment_is_untouched() {
        let html = "<!-- <mjx-container> --><p>hi</p>";
        let mut warnings = Vec::new();
        assert!(convert_mathjax_chtml(html, &mut warnings).is_none());
    }

    #[test]
    fn unclosed_container_recovers_absorbed_content() {
        let html = r#"<mjx-container><mjx-math><mjx-mn><mjx-c class="mjx-c31"></mjx-c></mjx-mn></mjx-math><p>article continues</p>"#;
        let out = convert(html);
        assert_eq!(
            out,
            format!(r#"<math xmlns="{MATHML_NS}"><mn>1</mn></math><p>article continues</p>"#)
        );
    }

    #[test]
    fn mspace_width_from_style() {
        let html = r#"<mjx-container><mjx-math><mjx-mspace style="width: 2em;"></mjx-mspace></mjx-math></mjx-container>"#;
        assert_eq!(
            convert(html),
            format!(r#"<math xmlns="{MATHML_NS}"><mspace width="2em"></mspace></math>"#)
        );
    }
}
