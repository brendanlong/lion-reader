//! The main HTML allow-list pass — port of `SANITIZE_OPTIONS` from
//! `src/server/html/sanitize.ts`, running on lol_html (streaming, no tree).
//!
//! Semantics ported from sanitize-html:
//! - Tags not on the allow-list are unwrapped (children kept), except the
//!   "non-text" tags (`script`/`style`/`textarea`/`option`) whose content is
//!   dropped with them.
//! - Attributes are allow-listed globally (`class`/`id`/`title`/`dir`/
//!   `lang`/`role`, `data-*`, `aria-*`, the MathML presentation set) plus
//!   per-tag additions. `role`/`aria-*` are inert ARIA hooks kept for
//!   assistive tech (e.g. `role="doc-noteref"` on footnotes).
//! - URL-carrying attributes are scheme-checked (http/https/mailto/tel;
//!   `data:image/*` additionally for img/source), on the entity-decoded value.
//!   Protocol-relative and relative URLs pass. `data:` is accepted only when
//!   its MIME type is `image/*` (so `data:text/html` never reaches an image
//!   sink); `data:image/svg+xml` is allowed because an SVG in an image context
//!   is passive (see `is_image_url_allowed`).
//! - Comments and doctypes are removed.
//! - The tag allow-list applies to end tags too, in a second byte pass over the
//!   rewriter's output — see `drop_disallowed_end_tags`, which is the only place
//!   here that deletes bytes lol_html already tokenized.
//! - Transforms: external links get `target="_blank" rel="noopener
//!   noreferrer"`; images get `loading="lazy"`; iframes survive only as
//!   normalized allow-listed embeds with a forced sandbox; `input` survives
//!   only as an inert, attribute-stripped task-list checkbox.
//!
//! Unlike sanitize-html, lol_html does not re-serialize untouched markup:
//! kept text and attribute values pass through byte-identical, and the
//! tokenizer is HTML5-spec-conformant (the same tokenization a browser
//! does), which removes the parser-differential class of bypasses.

use std::sync::LazyLock;

use lol_html::html_content::Element;
use lol_html::{doc_comments, doctype, element, HtmlRewriter, Settings};

use crate::embeds::normalize_embed;
use crate::idrefs::{prefix_fragment_href, prefix_id, prefix_id_list, ARIA_IDREF_ATTRS};
use crate::scanner::{
    find_byte, find_bytes, is_tag_ws, scan_to_tag_end, skip_raw_text, tag_name_end,
    RAW_TEXT_ELEMENTS,
};
use crate::urls::{decode_attr, is_image_url_allowed};

/// Tags allowed in entry content (sanitize.ts ALLOWED_TAGS + MATHML_TAGS).
const ALLOWED_TAGS: &[&str] = &[
    // Sections & blocks
    "p", "div", "span", "section", "article", "header", "footer", "main", "aside", "nav",
    "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr", "br", "figure",
    "figcaption", "details", "summary", "address",
    // Inline text semantics
    "a", "b", "strong", "i", "em", "u", "s", "strike", "del", "ins", "mark", "small", "sub",
    "sup", "abbr", "cite", "q", "code", "kbd", "samp", "var", "time", "wbr", "bdi", "bdo",
    "ruby", "rt", "rp", "dfn",
    // Lists
    "ul", "ol", "li", "dl", "dt", "dd",
    // Tables
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
    // Media
    "img", "picture", "source", "audio", "video", "track",
    // `input` is allowed ONLY as an inert GFM task-list checkbox (issue #1439):
    // handle_input drops every attribute, keeps `checked`, and forces
    // `type="checkbox" disabled`, so it can carry no name/value/form binding and
    // no event handler. Any other input type is removed entirely.
    "input",
    // `iframe` is allowed ONLY for allow-listed media-embed providers (issue
    // #922): handle_iframe validates the src against normalize_embed and
    // rewrites it to the provider's canonical host with a forced sandbox;
    // anything else is removed entirely.
    "iframe",
    // Presentation MathML (MathML Core renders natively). Excluded from the
    // allow-list (and no `href`): `semantics` is unwrapped so its presentation
    // child renders; `annotation`/`annotation-xml` are dropped with content
    // (see DROP_WITH_CONTENT — raw-TeX-source leak + mXSS vector).
    "math", "mrow", "mi", "mo", "mn", "ms", "mtext", "mspace", "msup", "msub", "msubsup",
    "mfrac", "msqrt", "mroot", "mover", "munder", "munderover", "mmultiscripts",
    "mprescripts", "mtable", "mtr", "mtd", "mlabeledtr", "mpadded", "mphantom", "menclose",
    "mstyle", "merror", "maction",
];

/// Disallowed tags whose content is dropped along with them, rather than
/// unwrapped (children kept).
///
/// This is `sanitize-html`'s `nonTextTags` default (`script`/`style`/
/// `textarea`/`option`) **plus every other element the HTML tokenizer treats
/// as raw text / RCDATA / escapable-raw-text**. That second set is critical
/// for XSS safety, not cosmetic: inside `<title>`/`<xmp>`/`<noembed>`/
/// `<noframes>`/`<noscript>`/`<plaintext>` the tokenizer reads the contents
/// as a single *text* run, so lol_html's `*` element handler never fires on
/// any markup in there. If we merely unwrapped the element, lol_html would
/// re-emit that text **verbatim** (it is a raw text chunk, not parsed
/// content), and since it is no longer inside a rawtext element the browser
/// re-parses it as live markup — e.g. `<title><img src=x onerror=alert(1)>`
/// would round-trip to an executing `<img>`. Dropping the whole subtree
/// closes that mutation-XSS path. (`iframe` is also a rawtext element but is
/// allow-listed and handled separately in `handle_iframe`, so it never
/// reaches here.)
const DROP_WITH_CONTENT: &[&str] = &[
    "script", "style", "textarea", "option", "title", "xmp", "noembed", "noframes", "noscript",
    "plaintext",
    // MathML annotations. `<semantics>` is unwrapped (its presentation-MathML
    // child renders natively), but its annotations must be dropped WITH content,
    // not unwrapped: `<annotation encoding="application/x-tex">` holds the raw
    // LaTeX source (KaTeX/MathJax emit it), which unwrapping would spill into
    // the page as visible text next to every equation; `<annotation-xml>` is an
    // HTML integration point and a classic mXSS vector, so dropping it and its
    // subtree is strictly safer than unwrapping (keeping children). Neither is
    // used for visual rendering or screen-reader a11y — those use the
    // presentation MathML we keep.
    "annotation", "annotation-xml",
];

/// Global attributes allowed on any element (`data-*` and `aria-*` handled
/// separately). `role` and `aria-*` are ARIA hooks: inert (no script, no URL,
/// no resource load), preserved byte-identically by lol_html, and required for
/// assistive tech — e.g. LessWrong footnotes carry `role="doc-noteref"` /
/// `"doc-endnotes"` / `"doc-endnote"` that screen readers announce as
/// footnotes. Allowing them matches DOMPurify's default ARIA handling.
const GLOBAL_ATTRS: &[&str] = &["class", "id", "title", "dir", "lang", "role"];

/// MathML presentation attributes — allowed on every element, matching
/// sanitize.ts's `allowedAttributes["*"]` (no `href`, no event handlers).
const MATHML_ATTRS: &[&str] = &[
    "displaystyle", "scriptlevel", "mathvariant", "mathcolor", "mathbackground", "dir",
    "display", "linethickness", "fence", "separator", "stretchy", "symmetric", "largeop",
    "movablelimits", "accent", "accentunder", "lspace", "rspace", "width", "height", "depth",
    "voffset", "open", "close", "separators", "notation", "columnalign", "rowalign",
    "columnspan", "rowspan", "columnlines", "rowlines", "subscriptshift", "superscriptshift",
];

const SAFE_SCHEMES: &[&str] = &["http", "https", "mailto", "tel"];
// img/source src (and srcset candidates): http/https + data URIs (feeds embed
// base64 images). Deliberately NOT mailto/tel — matches the old
// `allowedSchemesByTag` for img/source exactly. `data:` is MIME-gated to
// `image/*` by `is_image_url_allowed` (a `data:text/html` image source would
// otherwise be a stored-HTML sink), which still permits `data:image/svg+xml`
// since an SVG rendered as an image is passive.
const IMAGE_SCHEMES: &[&str] = &["http", "https", "data"];

fn tag_allowed(tag: &str) -> bool {
    ALLOWED_TAGS.contains(&tag)
}

/// [`ALLOWED_TAGS`] bucketed by first letter, derived from that one list so
/// there is still only one to edit. The end-tag pass tests a name for every `</`
/// in the document, and scanning all ~90 entries each time was visible on
/// `scripts/bench-sanitize.mts`; a bucket averages under ten.
static ALLOWED_TAGS_BY_INITIAL: LazyLock<[Vec<&'static str>; 26]> = LazyLock::new(|| {
    let mut buckets: [Vec<&'static str>; 26] = Default::default();
    for tag in ALLOWED_TAGS {
        // Every allow-listed name starts with an ASCII letter, so every one of
        // them lands in a bucket — `tag_allowed_bytes_matches_tag_allowed`
        // holds the two lookups to that.
        if let Some(index) = bucket_index(tag.as_bytes()) {
            buckets[index].push(tag);
        }
    }
    buckets
});

/// The [`ALLOWED_TAGS_BY_INITIAL`] index for a raw tag name, or None when its
/// first byte isn't an ASCII letter (so it can't be an allow-listed name).
fn bucket_index(tag: &[u8]) -> Option<usize> {
    let initial = tag.first()?.to_ascii_lowercase().wrapping_sub(b'a');
    (initial < 26).then(|| usize::from(initial))
}

/// [`tag_allowed`] for a not-yet-lowercased raw name, so the end-tag walk can
/// test a slice of the document instead of allocating a name per tag.
fn tag_allowed_bytes(tag: &[u8]) -> bool {
    bucket_index(tag).is_some_and(|index| {
        ALLOWED_TAGS_BY_INITIAL[index]
            .iter()
            .any(|allowed| allowed.as_bytes().eq_ignore_ascii_case(tag))
    })
}

/// The elements whose subtree is parsed as foreign content, where the tokenizer's
/// rules change under it (see [`drop_disallowed_end_tags`]). `svg` reaches the
/// end-tag pass only when SVG extraction degraded — `math` is the everyday one.
const FOREIGN_ROOTS: &[&str] = &["svg", "math"];

/// The entry of `names` matching the raw tag name `tag`, if any.
fn matching_name<'n>(tag: &[u8], names: &[&'n str]) -> Option<&'n str> {
    names
        .iter()
        .copied()
        .find(|name| name.as_bytes().eq_ignore_ascii_case(tag))
}

fn attr_allowed(tag: &str, name: &str) -> bool {
    if GLOBAL_ATTRS.contains(&name)
        || MATHML_ATTRS.contains(&name)
        || name.starts_with("data-")
        || name.starts_with("aria-")
    {
        return true;
    }
    match tag {
        "a" => matches!(name, "href" | "name" | "target" | "rel"),
        "img" => matches!(
            name,
            "src" | "srcset" | "sizes" | "alt" | "width" | "height" | "loading" | "decoding"
        ),
        "source" => matches!(name, "src" | "srcset" | "type" | "media" | "sizes"),
        "video" => matches!(
            name,
            "src" | "poster" | "width" | "height" | "controls" | "loop" | "muted" | "preload"
        ),
        "audio" => matches!(name, "src" | "controls" | "loop" | "muted" | "preload"),
        "track" => matches!(name, "src" | "kind" | "srclang" | "label" | "default"),
        // `align` is how Markdown/GFM tables carry column alignment
        // (`| :-: |`). Presentational only — no script or resource surface —
        // and value-checked by `canonical_align`.
        "th" => matches!(name, "colspan" | "rowspan" | "scope" | "headers" | "align"),
        "td" => matches!(name, "colspan" | "rowspan" | "headers" | "align"),
        "col" | "colgroup" => name == "span",
        "time" => name == "datetime",
        "math" => name == "xmlns",
        _ => false,
    }
}

/// `align` is the one keyword-valued attribute we allow, so its value is
/// constrained to the three alignments GFM emits — an allow-listed attribute
/// should never carry an arbitrary string. Returns the canonical spelling, or
/// None to drop the attribute.
///
/// Canonicalizing, not just checking, is what makes the attribute *do*
/// something: `align` is a presentational hint, so it only takes effect through
/// the reader CSS, which matches the exact token. Accepting ` CENTER ` (or an
/// entity-obfuscated `&#99;enter`) and writing it back raw would leave a cell
/// that survived sanitization and still rendered unaligned.
///
/// `#[cold]` for the reason described on [`handle_input`].
#[cold]
#[inline(never)]
fn canonical_align(value: &str) -> Option<&'static str> {
    match decode_attr(value).trim().to_ascii_lowercase().as_str() {
        "left" => Some("left"),
        "center" => Some("center"),
        "right" => Some("right"),
        _ => None,
    }
}

/// Schemes allowed for a URL-carrying attribute on a given tag; None when
/// the attribute doesn't carry a URL (no scheme check).
fn url_schemes_for(tag: &str, name: &str) -> Option<&'static [&'static str]> {
    match (tag, name) {
        ("a", "href") => Some(SAFE_SCHEMES),
        ("img", "src") | ("source", "src") => Some(IMAGE_SCHEMES),
        ("video", "src") | ("audio", "src") | ("track", "src") | ("video", "poster") => {
            Some(SAFE_SCHEMES)
        }
        _ => None,
    }
}

/// Splits a srcset value into candidate URLs, tolerant of commas inside URLs
/// (Cloudinary-style `f_auto,q_auto`): an entry boundary is a comma preceded
/// by a width/density descriptor or followed by something that looks like a
/// new URL. Mirrors `absolutizeSrcset` in content-cleaner.ts.
fn srcset_urls(value: &str) -> Vec<String> {
    fn has_descriptor(entry: &str) -> bool {
        let trimmed = entry.trim_end();
        let Some(last_ws) = trimmed.rfind(|c: char| c.is_whitespace()) else {
            return false;
        };
        let desc = &trimmed[last_ws + 1..];
        if desc.len() < 2 {
            return false;
        }
        let (num, suffix) = desc.split_at(desc.len() - 1);
        matches!(suffix, "w" | "x") && num.chars().all(|c| c.is_ascii_digit() || c == '.')
            && num.chars().any(|c| c.is_ascii_digit())
    }
    fn looks_like_new_entry(s: &str) -> bool {
        s.starts_with("http://")
            || s.starts_with("https://")
            || s.starts_with("data:")
            || s.starts_with("//")
            || s.starts_with('/')
    }
    let mut entries: Vec<String> = Vec::new();
    for raw in value.split(',') {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        match entries.last() {
            None => entries.push(trimmed.to_string()),
            Some(prev) => {
                if has_descriptor(prev) || looks_like_new_entry(trimmed) {
                    entries.push(trimmed.to_string());
                } else {
                    let last = entries.last_mut().unwrap();
                    last.push(',');
                    last.push_str(trimmed);
                }
            }
        }
    }
    entries
        .into_iter()
        .filter_map(|entry| entry.split_whitespace().next().map(str::to_string))
        .collect()
}

/// Iframes survive only as normalized allow-listed embeds: validate/rewrite
/// the src, keep only width/height/title from the source, and force
/// sandbox/allow/loading. Anything unrecognized is removed with its content.
fn handle_iframe(el: &mut Element) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let src = el.get_attribute("src");
    let embed = src.as_deref().and_then(|s| normalize_embed(&decode_attr(s)));
    let Some(embed) = embed else {
        el.remove();
        return Ok(());
    };
    let to_remove: Vec<String> = el
        .attributes()
        .iter()
        .map(|a| a.name())
        .filter(|n| !matches!(n.as_str(), "width" | "height" | "title"))
        .collect();
    for name in to_remove {
        el.remove_attribute(&name);
    }
    el.set_attribute("src", &embed.src)?;
    el.set_attribute("sandbox", embed.sandbox)?;
    el.set_attribute("allow", embed.allow)?;
    el.set_attribute("allowfullscreen", "")?;
    el.set_attribute("loading", "lazy")?;
    Ok(())
}

/// `input` survives only as the inert checkbox GFM task lists are made of
/// (`- [x] done`), which every Markdown renderer and GitHub itself emit as
/// `<input type="checkbox" checked disabled>`. Without it the checkbox is
/// stripped and a done item reads exactly like a not-done one (issue #1439).
///
/// Rebuilt from scratch rather than filtered, so the result is a fixed shape
/// no matter what the source wrote: every attribute is dropped (no `name`/
/// `value`/`form*` to submit, no event handler, no `id` to collide with our
/// UI), only the checked bit is carried over, and `disabled` is forced — so it
/// is not focusable, not editable and not submittable. Any other `type` is
/// removed entirely: nothing else about a form control belongs in entry
/// content.
///
/// `#[cold]`/`#[inline(never)]` are load-bearing, not decoration: inlined into
/// `handle_element` this and `canonical_align` cost a **measured 4-8%** on
/// article-shaped content (`scripts/bench-sanitize.mts`, `medium`/`large`),
/// because `handle_element` runs for every element of every entry on every read
/// while an `input` or an `align` appears in almost none of them. Keeping the
/// rare paths out of the hot function's body returns it to parity. Re-run the
/// bench before removing these — and note its run-to-run drift is a few percent,
/// so interleave the variants and check an A/A control first.
#[cold]
#[inline(never)]
fn handle_input(el: &mut Element) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let is_checkbox = el
        .get_attribute("type")
        .is_some_and(|t| decode_attr(&t).trim().eq_ignore_ascii_case("checkbox"));
    if !is_checkbox {
        el.remove();
        return Ok(());
    }
    let checked = el.has_attribute("checked");
    let to_remove: Vec<String> = el.attributes().iter().map(|a| a.name()).collect();
    for name in to_remove {
        el.remove_attribute(&name);
    }
    el.set_attribute("type", "checkbox")?;
    if checked {
        el.set_attribute("checked", "")?;
    }
    el.set_attribute("disabled", "")?;
    Ok(())
}

/// Namespacing of ids and same-document references happens inline in
/// `handle_element`'s attribute pass (see `idrefs.rs` for the reference surface).
///
/// Every value is read and written **raw** (not entity-decoded). lol_html's
/// `set_attribute` escapes `"` but not `&`, so writing back a decoded value
/// would peel one entity layer per pass — leaving `id="a&amp;b"` and
/// `href="#a&amp;b"` disagreeing after the rename, and making the pass
/// non-idempotent. Operating on raw bytes keeps the two sides in step by
/// construction. It also keeps the `#` test conservative: a raw value starting
/// with a literal `#` always decodes to a fragment, so this can only ever
/// under-match, never mistake a URL for a fragment.
///
/// Whether an attribute *name* can hold an id or an id reference. Pure name
/// test so the caller can skip reading the value. The `aria-` prefix check
/// guards the list scan, which would otherwise run for every attribute.
fn is_idref_attr(name: &str) -> bool {
    matches!(name, "id" | "name" | "headers" | "href")
        || (name.starts_with("aria-") && ARIA_IDREF_ATTRS.contains(&name))
}

/// The namespaced form of an id-defining or id-referencing attribute, or None
/// when this particular value needs no rewrite. Only called for names that
/// passed [`is_idref_attr`]. `name` must be lowercased, as lol_html gives it for
/// HTML elements.
fn namespaced_value(name: &str, value: &str) -> Option<String> {
    match name {
        // `name` on an `<a>` is the legacy anchor target, so it is an id too.
        "id" | "name" => Some(prefix_id(value)),
        "href" => prefix_fragment_href(value),
        // `headers` and the ARIA idrefs are space-separated id lists.
        _ => Some(prefix_id_list(value)),
    }
}

fn handle_element(el: &mut Element) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let tag = el.tag_name();
    if !tag_allowed(&tag) {
        if DROP_WITH_CONTENT.contains(&tag.as_str()) {
            el.remove();
        } else {
            el.remove_and_keep_content();
        }
        return Ok(());
    }
    if tag == "iframe" {
        return handle_iframe(el);
    }
    if tag == "input" {
        return handle_input(el);
    }

    let mut to_remove: Vec<String> = Vec::new();
    // Id/idref rewrites (see `namespaced_value`) are collected in this same
    // pass: a separate `get_attribute` probe per interesting name, or even a
    // second walk of the attribute list, measurably slowed every element down —
    // including elements with no id at all. Only attributes that survive the
    // allow-list are considered, so `to_remove` and `rewrites` stay disjoint and
    // a rewrite can never resurrect an attribute the filter just dropped.
    let mut rewrites: Vec<(String, String)> = Vec::new();
    for attr in el.attributes() {
        let name = attr.name();
        if !attr_allowed(&tag, &name) {
            to_remove.push(name);
            continue;
        }
        // Name test before `attr.value()`, which allocates. `align` is never an
        // idref, so this arm can settle it and skip the rest of the loop body.
        if name == "align" {
            let value = attr.value();
            match canonical_align(&value) {
                None => to_remove.push(name),
                Some(canonical) if canonical != value => {
                    rewrites.push((name, canonical.to_string()))
                }
                Some(_) => {}
            }
            continue;
        }
        if let Some(schemes) = url_schemes_for(&tag, &name) {
            // `is_image_url_allowed` matches `is_url_allowed` for every scheme
            // except `data:`, which it MIME-gates to `image/*`. `data` is only
            // ever in `IMAGE_SCHEMES` (image sinks), so this is a no-op for the
            // http/https/mailto/tel attributes and closes `data:text/html` on
            // `img`/`source` `src`.
            if !is_image_url_allowed(&decode_attr(&attr.value()), schemes) {
                to_remove.push(name);
                continue;
            }
        } else if name == "srcset" && matches!(tag.as_str(), "img" | "source") {
            let decoded = decode_attr(&attr.value()).into_owned();
            if !srcset_urls(&decoded)
                .iter()
                .all(|u| is_image_url_allowed(u, IMAGE_SCHEMES))
            {
                to_remove.push(name);
                continue;
            }
        }
        // Name test before `attr.value()`, which allocates: most attributes
        // (`class`, `alt`, `width`, …) hold no id and must not pay for a copy.
        if is_idref_attr(&name) {
            let value = attr.value();
            if let Some(rewritten) = namespaced_value(&name, &value) {
                // Skip no-op writes: `set_attribute` makes lol_html re-serialize
                // the whole start tag, so an already-prefixed value (a
                // re-sanitized summary) or an empty id must not pay for one.
                if rewritten != value {
                    rewrites.push((name, rewritten));
                }
            }
        }
    }
    for name in to_remove {
        el.remove_attribute(&name);
    }
    for (name, value) in rewrites {
        el.set_attribute(&name, &value)?;
    }

    if tag == "a" {
        // External links open in a new tab with a safe rel (anti
        // reverse-tabnabbing). Relative/in-page links are left alone.
        if let Some(href) = el.get_attribute("href") {
            let decoded = decode_attr(&href);
            let normalized = decoded.trim().to_ascii_lowercase();
            if normalized.starts_with("http://")
                || normalized.starts_with("https://")
                || normalized.starts_with("//")
            {
                el.set_attribute("target", "_blank")?;
                el.set_attribute("rel", "noopener noreferrer")?;
            }
        }
    } else if tag == "img" {
        el.set_attribute("loading", "lazy")?;
    }
    Ok(())
}

/// Apply the tag allow-list to *end* tags, which lol_html can't reach.
///
/// lol_html is a streaming rewriter with no tree, so it only ever hands us an
/// element (and with it, the end tag to remove) when it can pair an end tag with
/// an open element. An end tag that pairs with nothing is passed through
/// verbatim — so a feed that ships a stray `</body>` got one back in the
/// sanitized output. A browser ignores such a tag, but a *tree builder* need
/// not: linkedom ends the body there and drops everything after it, which
/// silently truncated LLM narration and AI summaries — both of which parse the
/// sanitized HTML server-side (issue #1455). Applying the allow-list to end tags
/// too fixes every consumer at once, and makes "the output contains only
/// allow-listed tags" true of end tags as well as start tags.
///
/// **Every end tag reaching here whose name is not allow-listed is stray by
/// construction**: a paired one was already removed with its start tag (or with
/// the whole subtree, for [`DROP_WITH_CONTENT`]). That is why this needs no open
/// element stack of its own, and why it can drop even a `</script>` — a real
/// `<script>` element left no end tag behind.
///
/// The safety requirement is that the output must **re-tokenize exactly as it did
/// before the cut** — mangling content is tolerable, fabricating markup is an XSS
/// bypass. Deleting a whole end-tag token gets the tokenizer *state* right for
/// free (an end tag returns to the data state either side of the cut), but that
/// alone is not enough, and three things carry the rest. Each of them was a
/// working `<img onerror>` injection before it was there, so treat them as
/// load-bearing:
///
/// * Only a **bare** `</name>` is cut ([`bare_end_tag_end`]). Because lol_html
///   passes an unpaired end tag through byte-for-byte, a feed can park arbitrary
///   markup in one's attribute value (`</body " a="x><img src=x onerror=…>">`,
///   which is a single ignored token) where the main pass never reaches it — so
///   the cut must not be able to open one. Nothing decides these bytes but the
///   name, optional whitespace and `>`.
/// * The cut is refused when what precedes it could **join** what follows
///   ([`cut_would_splice`]) — above all a lone `<`, which the tokenizer emitted
///   as a character only because our `<` followed it.
/// * Nothing is cut inside **foreign content** ([`FOREIGN_ROOTS`]). Whether a
///   start tag opens a raw-text run is the one question the tokenizer asks the
///   *tree* — an `<iframe>` is raw text in HTML and an ordinary element in SVG —
///   so cutting a `</svg>` re-namespaces everything after it and can turn an
///   embed's unsanitized fallback text into live markup. CDATA has the same
///   shape (it exists only in foreign content, and lol_html passes its contents
///   through untouched), so the whole region is left alone.
/// * `iframe` is the only raw-text element the allow-list keeps, and it is
///   allow-listed — so we can never delete the end tag that closes a raw-text
///   run and spill its contents into the document as live markup. Adding a
///   raw-text element to the unwrap path (see [`DROP_WITH_CONTENT`]) would break
///   this.
///
/// `end_tag_drop_never_adds_markup` is the property test that stands behind all
/// three; it is a differential against a real tree builder over generated
/// fragments, not a list of examples, because examples are what missed them.
///
/// Returns `None` when there was nothing to drop — the overwhelmingly common
/// case, which [`has_disallowed_end_tag`] settles without walking tags at all.
///
/// Runs on the rewriter's output rather than its input because "unpaired" is
/// only knowable afterwards — and it must therefore run **before SVG
/// re-insertion**, since SVG content has its own allow-list (`svg.rs`) full of
/// tags like `</desc>` that this one has never heard of.
fn drop_disallowed_end_tags(html: &str) -> Option<String> {
    if !has_disallowed_end_tag(html.as_bytes()) {
        return None;
    }
    Some(rewrite_dropping_disallowed_end_tags(html))
}

/// Whether the walk below could find anything to drop: is there a `</name`
/// anywhere in `bytes` — at a tag position or not — whose name isn't
/// allow-listed?
///
/// A deliberate over-approximation of the walk (which only considers real tag
/// positions), so it is safe to skip the walk when this says no. Almost every
/// body takes that exit, and taking it on a SIMD substring search over the bytes
/// is what keeps the whole pass off the profile: the walk itself has to visit
/// every attribute byte to know where tags end.
fn has_disallowed_end_tag(bytes: &[u8]) -> bool {
    memchr::memmem::find_iter(bytes, b"</").any(|lt| {
        let name = &bytes[lt + 2..tag_name_end(bytes, lt + 2)];
        name.first().is_some_and(u8::is_ascii_alphabetic) && !tag_allowed_bytes(name)
    })
}

/// The index just past a **bare** end tag whose name ends at `name_end`: nothing
/// between the name and the `>` but whitespace. None for anything else, which the
/// walk then leaves alone.
///
/// This is the one deletable shape, and the restriction is a security boundary,
/// not tidiness — see [`drop_disallowed_end_tags`]. It also needs no attribute
/// scanning at all, so no divergence from the tokenizer's attribute states can
/// put the cut in the wrong place.
fn bare_end_tag_end(bytes: &[u8], name_end: usize) -> Option<usize> {
    let mut i = name_end;
    while bytes.get(i).copied().is_some_and(is_tag_ws) {
        i += 1;
    }
    (bytes.get(i) == Some(&b'>')).then_some(i + 1)
}

/// Whether cutting the bytes at `lt` would let what precedes them join what
/// follows into something that wasn't there before. Two ways that can happen,
/// both in the data state, and both from a *complete* preceding token:
///
/// * A `<` the tokenizer emitted as a **character** — it does that when the next
///   byte can't start a tag name, which is exactly the case when our `<` is next.
///   Remove our bytes and it becomes a real tag-open: `<</body>img src=x
///   onerror=alert(1)>` is inert text until the cut, then a live `<img>`. Only
///   the immediately preceding byte can do this, because a `<` further back is
///   still followed by the same byte afterwards.
/// * An unterminated **character reference**: `&am</body>p;` joins into `&amp;`,
///   which changes the text the reader sees (a reference can only ever produce
///   character data, so this one mangles rather than injects — but the cut is
///   supposed to be invisible).
fn cut_would_splice(bytes: &[u8], lt: usize) -> bool {
    if lt > 0 && bytes[lt - 1] == b'<' {
        return true;
    }
    let mut i = lt;
    while i > 0 && (bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'#') {
        i -= 1;
    }
    i > 0 && bytes[i - 1] == b'&'
}

/// The rare path of [`drop_disallowed_end_tags`]: walk the tags the way the
/// tokenizer does and cut the end tags the allow-list rejects.
fn rewrite_dropping_disallowed_end_tags(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out: Option<String> = None;
    // Everything before this has either been copied into `out` or dropped.
    let mut kept_to = 0usize;
    let mut i = 0usize;
    // How deep we are in foreign content, by name-matched depth. Only ever an
    // over-estimate (an unclosed `<svg>` holds it open to EOF, and integration
    // points that hand parsing back to HTML aren't modelled), which costs missed
    // cuts and nothing else.
    let mut foreign_depth = 0usize;
    while let Some(lt) = find_byte(bytes, i, b'<') {
        i = lt + 1;
        if bytes[lt..].starts_with(b"<!--") {
            i = find_bytes(bytes, lt + 4, b"-->").map(|p| p + 3).unwrap_or(bytes.len());
        } else if i < bytes.len() && matches!(bytes[i], b'!' | b'?') {
            // Bogus comment / doctype: ends at the first `>`.
            i = find_byte(bytes, i, b'>').map(|p| p + 1).unwrap_or(bytes.len());
        } else if i < bytes.len() && bytes[i] == b'/' {
            if !(i + 1 < bytes.len() && bytes[i + 1].is_ascii_alphabetic()) {
                // `</>` or `</ …`: a bogus comment per spec, not an end tag.
                i = find_byte(bytes, i + 1, b'>').map(|p| p + 1).unwrap_or(bytes.len());
                continue;
            }
            let after_name = tag_name_end(bytes, lt + 2);
            // An end tag may carry (ignored) attributes; the walk steps over the
            // whole thing either way, but only a bare one can be cut.
            let bare_end = bare_end_tag_end(bytes, after_name);
            i = bare_end.unwrap_or_else(|| scan_to_tag_end(bytes, after_name).0);
            let name = &bytes[lt + 2..after_name];
            if let Some(end) = bare_end {
                if foreign_depth == 0
                    && !tag_allowed_bytes(name)
                    && !cut_would_splice(bytes, lt)
                {
                    out.get_or_insert_with(|| String::with_capacity(html.len()))
                        .push_str(&html[kept_to..lt]);
                    kept_to = end;
                }
            }
            if matching_name(name, FOREIGN_ROOTS).is_some() {
                foreign_depth = foreign_depth.saturating_sub(1);
            }
        } else if i < bytes.len() && bytes[i].is_ascii_alphabetic() {
            let after_name = tag_name_end(bytes, i);
            let (tag_end, self_closing) = scan_to_tag_end(bytes, after_name);
            if !self_closing && matching_name(&bytes[i..after_name], FOREIGN_ROOTS).is_some() {
                // In foreign content a `/` really does close the element, so a
                // self-closing root opens nothing.
                foreign_depth += 1;
            }
            // Markup inside a raw-text element is text, not tags (in practice
            // only `<iframe>` gets here — every other raw-text element is
            // dropped with its content by the main pass). A self-closing `/` is
            // deliberately not consulted: an HTML element ignores it, so
            // `<iframe …/>` still opens a raw-text run, and lol_html preserves
            // the slash when it re-serializes the start tag.
            i = match matching_name(&bytes[i..after_name], RAW_TEXT_ELEMENTS) {
                Some(name) => skip_raw_text(bytes, tag_end, name),
                None => tag_end,
            };
        }
        // Anything else is a lone `<` in text; `i` already stepped past it.
    }
    // `has_disallowed_end_tag` over-approximates, so the walk can find nothing
    // to cut (a `</body>` that turned out to sit inside an attribute value).
    let mut out = out.unwrap_or_else(|| String::with_capacity(html.len()));
    out.push_str(&html[kept_to..]);
    out
}

/// Run the allow-list pass over `html`. Errors (rewriter failure) must be
/// treated as fatal by the caller — there is no partial output to serve.
pub fn sanitize_html_pass(html: &str) -> Result<String, String> {
    let mut output = Vec::with_capacity(html.len());
    let mut rewriter = HtmlRewriter::new(
        Settings {
            element_content_handlers: vec![element!("*", handle_element)],
            document_content_handlers: vec![
                doc_comments!(|c| {
                    c.remove();
                    Ok(())
                }),
                doctype!(|d| {
                    d.remove();
                    Ok(())
                }),
            ],
            ..Settings::new()
        },
        |chunk: &[u8]| output.extend_from_slice(chunk),
    );
    rewriter.write(html.as_bytes()).map_err(|e| e.to_string())?;
    rewriter.end().map_err(|e| e.to_string())?;
    let rewritten = String::from_utf8(output).map_err(|e| e.to_string())?;
    Ok(drop_disallowed_end_tags(&rewritten).unwrap_or(rewritten))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sanitize(html: &str) -> String {
        sanitize_html_pass(html).unwrap()
    }

    #[test]
    fn strips_script_with_content_unwraps_unknown() {
        assert_eq!(
            sanitize("<p>ok</p><script>alert(1)</script><custom>kept</custom>"),
            "<p>ok</p>kept"
        );
    }

    #[test]
    fn removes_event_handlers_and_bad_schemes() {
        assert_eq!(
            sanitize(r#"<img src="x" onerror="alert(1)"><a href="javascript:alert(1)">x</a>"#),
            r#"<img src="x" loading="lazy"><a>x</a>"#
        );
    }

    #[test]
    fn entity_encoded_scheme_is_caught() {
        assert_eq!(
            sanitize(r#"<a href="java&#115;cript:alert(1)">x</a>"#),
            "<a>x</a>"
        );
    }

    #[test]
    fn external_links_get_target_and_rel() {
        assert_eq!(
            sanitize(r#"<a href="https://example.com">x</a><a href="/local">y</a>"#),
            r#"<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a><a href="/local">y</a>"#
        );
    }

    // Namespacing tests use escaped strings rather than `r#"…"#`: the literals
    // contain `"#`, which closes a single-hash raw string early.

    #[test]
    fn ids_and_in_page_links_are_namespaced_together() {
        // The pair has to move as one, or the link stops resolving.
        assert_eq!(
            sanitize("<a href=\"#intro\">go</a><h2 id=\"intro\">Intro</h2>"),
            "<a href=\"#uc-intro\">go</a><h2 id=\"uc-intro\">Intro</h2>"
        );
    }

    #[test]
    fn namespaces_every_aria_idref_attribute() {
        // Driven off the constant so a typo in an entry can't ship silently.
        for attr in ARIA_IDREF_ATTRS {
            let out = sanitize(&format!("<p {attr}=\"a b\">x</p>"));
            assert!(
                out.contains(&format!("{attr}=\"uc-a uc-b\"")),
                "{attr} not namespaced: {out}"
            );
        }
    }

    #[test]
    fn namespaces_every_reference_kind_the_allow_list_keeps() {
        let out = sanitize("<p id=\"d\" aria-labelledby=\"l1 l2\" aria-describedby=\"d1\">x</p>");
        assert!(out.contains("id=\"uc-d\""), "{out}");
        assert!(out.contains("aria-labelledby=\"uc-l1 uc-l2\""), "{out}");
        assert!(out.contains("aria-describedby=\"uc-d1\""), "{out}");

        let table = sanitize("<table><tr><th id=\"h\">H</th><td headers=\"h\">v</td></tr></table>");
        assert!(table.contains("id=\"uc-h\""), "{table}");
        assert!(table.contains("headers=\"uc-h\""), "{table}");

        // Legacy `<a name>` is an anchor target, so it moves with the ids.
        let anchor = sanitize("<a name=\"top\"></a><a href=\"#top\">up</a>");
        assert!(anchor.contains("name=\"uc-top\""), "{anchor}");
        assert!(anchor.contains("href=\"#uc-top\""), "{anchor}");
    }

    #[test]
    fn leaves_off_site_and_bare_fragment_hrefs_alone() {
        let out = sanitize("<a href=\"https://example.com/#intro\">x</a><a href=\"#\">top</a>");
        assert!(out.contains("href=\"https://example.com/#intro\""), "{out}");
        assert!(out.contains("href=\"#\""), "{out}");
    }

    #[test]
    fn namespacing_survives_re_sanitizing() {
        // Cached summaries are re-sanitized on read, so a second pass must not
        // stack another prefix (which would break the matching id).
        let once = sanitize("<a href=\"#intro\">go</a><h2 id=\"intro\">Intro</h2>");
        assert_eq!(sanitize(&once), once);
    }

    #[test]
    fn entity_carrying_ids_stay_in_step_and_idempotent() {
        // Values are rewritten raw. If they were decoded first, lol_html (which
        // escapes `"` but not `&`) would peel an entity layer per pass, so the
        // id and the href would disagree and a second pass would drift again.
        let once = sanitize("<h2 id=\"a&amp;b\">x</h2><a href=\"#a&amp;b\">y</a>");
        assert!(once.contains("id=\"uc-a&amp;b\""), "{once}");
        assert!(once.contains("href=\"#uc-a&amp;b\""), "{once}");
        assert_eq!(sanitize(&once), once);
    }

    #[test]
    fn a_rewritten_fragment_href_cannot_smuggle_a_scheme() {
        // The written value always begins with `#`, so no scheme can appear.
        let out = sanitize("<a href=\"#&#106;avascript:alert(1)\">x</a>");
        assert!(out.contains("href=\"#uc-"), "{out}");
        assert!(!out.contains("javascript:alert(1)\">"), "{out}");
    }

    #[test]
    fn does_not_namespace_aria_attributes_that_are_not_idrefs() {
        let out = sanitize("<p aria-label=\"hello\" aria-hidden=\"true\">x</p>");
        assert!(out.contains("aria-label=\"hello\""), "{out}");
        assert!(out.contains("aria-hidden=\"true\""), "{out}");
    }

    #[test]
    fn iframe_embeds_only_for_providers() {
        assert_eq!(
            sanitize(r#"<iframe src="https://evil.com/page"></iframe><p>after</p>"#),
            "<p>after</p>"
        );
        let out = sanitize(
            r#"<iframe width="560" src="https://www.youtube.com/embed/abc123?autoplay=1"></iframe>"#,
        );
        assert!(out.contains(r#"src="https://www.youtube-nocookie.com/embed/abc123""#), "{out}");
        assert!(out.contains(r#"width="560""#));
        assert!(out.contains("sandbox="));
        assert!(!out.contains("autoplay"));
    }

    #[test]
    fn comments_and_doctype_removed() {
        assert_eq!(sanitize("<!DOCTYPE html><!-- hi --><p>x</p>"), "<p>x</p>");
    }

    #[test]
    fn data_uri_images_allowed_but_not_links() {
        assert_eq!(
            sanitize(r#"<img src="data:image/png;base64,AAA="><a href="data:text/html,x">x</a>"#),
            r#"<img src="data:image/png;base64,AAA=" loading="lazy"><a>x</a>"#
        );
    }

    #[test]
    fn mathml_preserved() {
        let math = r#"<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi><msup><mi>y</mi><mn>2</mn></msup></math>"#;
        assert_eq!(sanitize(math), math);
    }

    #[test]
    fn mathml_semantics_unwrapped_annotation_dropped() {
        // KaTeX/MathJax output: `<semantics>` wraps the presentation MathML plus
        // a TeX `<annotation>`. `<semantics>` is unwrapped (presentation kept),
        // but the annotation is dropped WITH content so the raw TeX never spills
        // out as visible text next to the equation.
        let input = r#"<math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><msup><mi>c</mi><mn>2</mn></msup></mrow><annotation encoding="application/x-tex">c^2</annotation></semantics></math>"#;
        assert_eq!(
            sanitize(input),
            r#"<math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><msup><mi>c</mi><mn>2</mn></msup></mrow></math>"#
        );
    }

    #[test]
    fn mathml_annotation_xml_html_payload_dropped() {
        // `<annotation-xml encoding="text/html">` is an HTML integration point
        // (classic MathML mXSS vector). It and its subtree must be dropped, not
        // unwrapped — otherwise the payload's children would be re-parsed.
        let input = r#"<math><semantics><mrow><mi>x</mi></mrow><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></semantics></math>"#;
        let out = sanitize(input);
        assert_eq!(out, "<math><mrow><mi>x</mi></mrow></math>");
        assert!(!out.contains("onerror"), "{out}");
        assert!(!out.contains("<img"), "{out}");
    }

    #[test]
    fn srcset_with_bad_scheme_dropped_entirely() {
        assert_eq!(
            sanitize(r#"<img src="a.png" srcset="javascript:x 1x, b.png 2x">"#),
            r#"<img src="a.png" loading="lazy">"#
        );
        let ok = r#"<img src="a.png" srcset="https://x.com/f_auto,q_auto/a.png 1x, /b.png 2x" loading="lazy">"#;
        assert_eq!(sanitize(ok), ok);
    }

    #[test]
    fn style_content_dropped() {
        assert_eq!(sanitize("<style>p{}</style><p>x</p>"), "<p>x</p>");
    }

    #[test]
    fn rawtext_element_content_is_dropped_not_unwrapped() {
        // Inside a rawtext/RCDATA element the tokenizer reads markup as text,
        // so unwrapping would re-emit it verbatim and the browser would
        // re-parse it as a live element (mXSS). All such non-allow-listed
        // elements must drop their whole subtree.
        for tag in ["title", "xmp", "noembed", "noframes", "noscript", "plaintext", "textarea"] {
            let input = format!("<p>ok</p><{tag}><img src=x onerror=alert(1)></{tag}>");
            let out = sanitize(&input);
            assert!(
                !out.contains("onerror") && !out.contains("<img"),
                "tag {tag}: {out}"
            );
            assert!(out.starts_with("<p>ok</p>"), "tag {tag}: {out}");
        }
    }

    #[test]
    fn img_src_rejects_mailto_tel_but_keeps_data() {
        // img/source src is http/https/data only (parity with the old
        // allowedSchemesByTag) — mailto/tel are not image sources.
        assert_eq!(sanitize(r#"<img src="mailto:x@y.com">"#), r#"<img loading="lazy">"#);
        assert_eq!(
            sanitize(r#"<img src="data:image/png;base64,AAA=">"#),
            r#"<img src="data:image/png;base64,AAA=" loading="lazy">"#
        );
    }

    #[test]
    fn img_src_data_must_be_image_mime() {
        // `data:` is allowed on image sinks only when the MIME type is image/*.
        // `data:image/svg+xml` stays (passive image context); `data:text/html`
        // and other non-image data URLs are dropped from src and srcset.
        assert_eq!(
            sanitize(r#"<img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">"#),
            r#"<img src="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" loading="lazy">"#
        );
        assert_eq!(
            sanitize(r#"<img src="data:text/html,<script>alert(1)</script>">"#),
            r#"<img loading="lazy">"#
        );
        // A non-image data: candidate drops the whole srcset (all-or-nothing).
        assert_eq!(
            sanitize(r#"<img src="a.png" srcset="data:text/html,x 1x, b.png 2x">"#),
            r#"<img src="a.png" loading="lazy">"#
        );
        let ok = r#"<img srcset="data:image/png;base64,AAA= 1x, /b.png 2x" loading="lazy">"#;
        assert_eq!(sanitize(ok), ok);
    }

    #[test]
    fn task_list_checkboxes_survive_as_inert_checkboxes() {
        // The checked bit is the whole point: without it a done item and a
        // not-done item render identically (issue #1439).
        assert_eq!(
            sanitize(
                r#"<ul><li><input type="checkbox" checked="" disabled=""> done</li><li><input type="checkbox" disabled=""> todo</li></ul>"#
            ),
            r#"<ul><li><input type="checkbox" checked="" disabled=""> done</li><li><input type="checkbox" disabled=""> todo</li></ul>"#
        );
    }

    #[test]
    fn checkbox_is_rebuilt_so_it_can_carry_nothing_else() {
        // Every source attribute is dropped and `disabled` forced, so the
        // checkbox has no name/value/form binding, no handler and no id.
        let out = sanitize(
            r#"<input type="CheckBox" checked name="a" value="b" form="f" formaction="https://e.com" id="x" onclick="alert(1)" class="c">"#,
        );
        assert_eq!(out, r#"<input type="checkbox" checked="" disabled="">"#);
    }

    #[test]
    fn non_checkbox_inputs_are_removed() {
        for input in [
            r#"<input type="text" value="x">"#,
            r#"<input type="image" src="https://e.com/x.png">"#,
            r#"<input type="password">"#,
            r#"<input type="submit">"#,
            // The one type the tree builder inserts in place inside a table
            // (every other input is foster-parented out).
            r#"<input type="hidden" name="csrf" value="x">"#,
            "<input>",
        ] {
            let out = sanitize(&format!("<p>a</p>{input}<p>b</p>"));
            assert_eq!(out, "<p>a</p><p>b</p>", "{input}");
        }
    }

    #[test]
    fn table_alignment_kept_only_for_real_alignments() {
        let aligned = r#"<table><tr><th align="left">a</th><th align="center">b</th><td align="right">c</td></tr></table>"#;
        assert_eq!(sanitize(aligned), aligned);
        // Anything outside the GFM vocabulary is dropped, and `align` is not a
        // global — it only exists on cells.
        assert_eq!(
            sanitize(r#"<table><tr><td align="expression(x)">c</td></tr></table>"#),
            "<table><tr><td>c</td></tr></table>"
        );
        // `align` is scoped to cells, not global — including on the legacy-HTML
        // tags where it used to be valid, which is where it would most plausibly
        // creep back in from feed markup.
        for tag in ["p", "table", "tr", "col", "colgroup", "div", "img", "mtd"] {
            let out = sanitize(&format!("<{tag} align=\"center\">x</{tag}>"));
            assert!(!out.contains("align"), "{tag}: {out}");
        }
    }

    #[test]
    fn surviving_align_is_always_canonical() {
        // The CSS that gives `align` its effect matches the exact token, so a
        // padded/uppercase/entity-obfuscated value must be rewritten, not just
        // accepted — otherwise the cell renders unaligned despite the attribute.
        for raw in [r#" CENTER "#, "Center", "&#99;enter"] {
            let out = sanitize(&format!("<td align=\"{raw}\">x</td>"));
            assert_eq!(out, r#"<td align="center">x</td>"#, "{raw}");
        }
        // Already canonical: left untouched, so no start-tag re-serialization.
        let canonical = r#"<td align="center">x</td>"#;
        assert_eq!(sanitize(canonical), canonical);
        // Idempotent, like every other rewrite in this pass.
        let once = sanitize(r#"<td align=" CENTER ">x</td>"#);
        assert_eq!(sanitize(&once), once);
    }

    #[test]
    fn data_attributes_kept() {
        assert_eq!(
            sanitize(r#"<p data-para-id="7" class="a" bogus="1">x</p>"#),
            r#"<p data-para-id="7" class="a">x</p>"#
        );
    }

    #[test]
    fn tag_allowed_bytes_matches_tag_allowed() {
        // The end-tag pass reads the allow-list through a bucketed index, so a
        // tag that lands in no bucket would silently lose its end tags.
        for tag in ALLOWED_TAGS {
            assert!(tag_allowed_bytes(tag.as_bytes()), "{tag} missing from the index");
            assert!(
                tag_allowed_bytes(tag.to_ascii_uppercase().as_bytes()),
                "{tag} not matched case-insensitively"
            );
        }
        for tag in DROP_WITH_CONTENT.iter().chain(&["body", "html", "head", ""]) {
            assert!(!tag_allowed_bytes(tag.as_bytes()), "{tag} wrongly allow-listed");
        }
    }

    #[test]
    fn stray_end_tags_are_dropped_like_their_start_tags() {
        // A stray `</body>`/`</html>` used to survive and truncate every
        // server-side tree build of the output (issue #1455).
        assert_eq!(
            sanitize("<p>a</p></body><p>b</p></html><p>c</p>"),
            "<p>a</p><p>b</p><p>c</p>"
        );
        // Case-insensitive, and trailing whitespace is still a bare end tag.
        assert_eq!(sanitize("<p>a</p></BODY  ><p>b</p>"), "<p>a</p><p>b</p>");
        // Unpaired end tags for elements the main pass drops with their content
        // are stray too — a real `<script>` leaves no end tag behind.
        assert_eq!(sanitize("<p>a</p></script><p>b</p>"), "<p>a</p><p>b</p>");
        assert_eq!(sanitize("<p>a</p></custom><p>b</p>"), "<p>a</p><p>b</p>");
        // Allow-listed end tags are untouched, paired or not: a browser and a
        // tree builder both just ignore a stray one.
        assert_eq!(sanitize("<p>a</p></div><p>b</p>"), "<p>a</p></div><p>b</p>");
    }

    #[test]
    fn an_end_tag_with_attributes_is_left_alone() {
        // lol_html hands an unpaired end tag through byte-for-byte, attributes
        // and all, so a feed can park markup in one where the main pass never
        // reaches it. `</body " a="x><img …>">` is a single ignored token; ending
        // the "tag" anywhere but its real `>` cuts that value open and the
        // payload goes live. Only bare end tags are cut, so none of this is
        // reachable — at the cost of leaving a (vanishingly rare) attributed
        // `</body>` in place.
        for html in [
            r#"<p>a</p></body " x="y><img src=q onerror=alert(1)>">"#,
            r#"<p>a</p></o " x="y><script>alert(1)</script>">"#,
            r#"<p>a</p></body class="x><p>b</p>"#,
            "<p>a</p></body it's><p>b</p>",
            // Nor may it swallow the rest of the document looking for a `>`.
            "<p>a</p></body",
        ] {
            let out = sanitize(html);
            assert_eq!(out, html, "{html}");
        }
    }

    #[test]
    fn end_tag_shaped_text_inside_markup_is_left_alone() {
        // The pass walks tags the way the tokenizer does, so a `</body>` that is
        // not an end tag at all must survive byte-identically.
        let attr = "<p title=\"</body>\">a</p>";
        assert_eq!(sanitize(attr), attr);
        // Inside a raw-text element the "tags" are text. `iframe` is the only
        // raw-text element that survives the allow-list, so it is the only place
        // this can be observed — including self-closed, since an HTML element
        // ignores the `/` and opens the raw-text run anyway.
        for open in [
            r#"<iframe src="https://www.youtube.com/embed/abc123">"#,
            r#"<iframe src="https://www.youtube.com/embed/abc123"/>"#,
        ] {
            let out = sanitize(&format!("{open}</body><p>fallback</p></iframe>"));
            assert!(out.contains("</body><p>fallback</p></iframe>"), "{out}");
        }
    }

    #[test]
    fn a_cut_that_would_splice_its_neighbours_is_refused() {
        // A lone `<` is emitted as a *character* precisely because our `<`
        // follows it, so deleting our bytes would promote it to a tag-open and
        // fabricate a live element out of inert text.
        for html in [
            "<p>hi</p><</body>img src=x onerror=alert(1)>",
            "<p>a < b</p><</html>img src=x onerror=alert(1)>",
        ] {
            let out = sanitize(html);
            assert_eq!(out, html, "{html}");
        }
        // An unterminated character reference would join across the cut too.
        // Only text is at stake there, but the cut is meant to be invisible.
        assert_eq!(sanitize("<p>&am</body>p;</p>"), "<p>&am</body>p;</p>");
        // The terminated form has nothing to join to, so it is cut as usual.
        assert_eq!(sanitize("<p>&amp;</body>x</p>"), "<p>&amp;x</p>");
    }

    #[test]
    fn dropping_a_stray_end_tag_cannot_fabricate_markup() {
        // Escaped text either side of the cut stays escaped: the tokenizer is in
        // the data state on both sides, so the halves join as text.
        let out = sanitize("<p>&lt;img src=x onerror=alert(1)</body>&gt;</p>");
        assert_eq!(out, "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    }

    /// Every element and attribute the fragment `html` parses to, per a real
    /// (html5ever) tree builder — the same shape a browser builds.
    fn tree_shape(html: &str) -> Vec<String> {
        let mut shape: Vec<String> = Vec::new();
        for node in scraper::Html::parse_fragment(html).tree.nodes() {
            if let Some(el) = node.value().as_element() {
                let name = el.name().to_owned();
                shape.extend(el.attrs().map(|(attr, _)| format!("{name}@{attr}")));
                shape.push(name);
            }
        }
        shape.sort();
        shape
    }

    #[test]
    fn end_tag_drop_never_adds_markup() {
        // The invariant the end-tag pass rests on — its output must tree-build to
        // nothing that wasn't already there — held as a *differential* against a
        // real tree builder over generated fragments. Every bypass this pass has
        // had was found this way and missed by hand-written examples, so keep it a
        // property, not a list of cases (issue #1455).
        //
        // The pass is exercised directly, on arbitrary strings rather than only
        // rewriter output: it adds nothing anywhere, which is stronger than it
        // needs to be and leaves nothing to whitelist.
        //
        // Shapes that have produced a mis-parse: punctuation the tokenizer treats
        // specially, quotes where an attribute name goes, raw text and foreign
        // content, half a character reference, a payload to notice going live.
        const PIECES: &[&str] = &[
            "<", ">", "/", "=", "\"", "'", "&", " ", "a", "x=y", "</body>", "</html>", "</o",
            "<p>", "</p>", "<img src=q onerror=alert(1)>", "<script>alert(1)</script>", "&am",
            "p;", "&#3", "9;", "-->", "]]>", "😀", "<div title=", "</iframe>", "<math>",
            "<mtext>", "<svg>", "</svg>", "</ ", "</>",
            r#"<iframe src="https://www.youtube.com/embed/abc123">"#,
        ];
        // A deterministic LCG, so a failure reproduces from its seed alone.
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let mut next = move || {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963);
            (seed >> 33) as usize
        };
        let mut cut_something = 0usize;
        for _ in 0..50_000 {
            let input: String = (0..2 + next() % 8).map(|_| PIECES[next() % PIECES.len()]).collect();
            let Some(out) = drop_disallowed_end_tags(&input) else {
                continue;
            };
            cut_something += usize::from(out != input);
            let before = tree_shape(&input);
            for item in tree_shape(&out) {
                assert!(
                    before.contains(&item),
                    "the end-tag pass added {item}\n  in : {input:?}\n  out: {out:?}"
                );
            }
            // Stored summaries are re-sanitized on every read, so a second pass
            // must not find more to cut.
            assert_eq!(
                drop_disallowed_end_tags(&out).unwrap_or_else(|| out.clone()),
                out,
                "not idempotent: {input:?}"
            );
        }
        // Guard against the generator drifting into shapes that never cut, which
        // would leave the property above vacuously true.
        assert!(cut_something > 1_000, "only {cut_something} inputs were cut");
    }

    #[test]
    fn aria_and_role_attributes_kept() {
        // ARIA hooks are inert and required for assistive tech (e.g. footnotes).
        assert_eq!(
            sanitize(
                r#"<ol role="doc-endnotes"><li role="doc-endnote" aria-label="Footnote 1">x</li></ol>"#
            ),
            r#"<ol role="doc-endnotes"><li role="doc-endnote" aria-label="Footnote 1">x</li></ol>"#
        );
    }
}
