//! Turns pdf_oxide's per-page Markdown into one continuous article: drops page
//! furniture (running headers/footers, page numbers), rejoins paragraphs split
//! by a page break, turns numbered bold section titles into headings, and
//! undoes line-break hyphenation.
//!
//! Works on blocks (runs of lines between blank lines), which is how pdf_oxide
//! separates paragraphs, headings, lists and tables. The images `images`
//! placed are blocks of their own, which the text passes look past.

use std::collections::{HashMap, HashSet};

use crate::images::IMAGE_URL_SCHEME;

/// Blocks at each end of a page checked for headers and footers. Two covers a
/// page number plus a running title on its own line.
const EDGE_BLOCKS: usize = 2;
/// A running header or footer is short; longer edge blocks are content.
const MAX_FURNITURE_WORDS: usize = 12;
/// Pages a short edge block must repeat on to count as a running header.
/// Absolute, not a fraction of the document: a book's per-chapter header only
/// repeats within its chapter.
pub const MIN_RUNNING_HEADER_PAGES: usize = 3;
/// Longest numbered bold line still treated as a section title.
const MAX_SECTION_TITLE_WORDS: usize = 15;

pub fn assemble(pages: Vec<String>) -> String {
    let mut pages: Vec<Vec<String>> = pages
        .iter()
        .map(|page| split_blocks(page).map(merge_bold_runs).collect())
        .collect();
    strip_page_furniture(&mut pages);
    let blocks: Vec<String> = join_pages(pages)
        .into_iter()
        .map(|block| promote_section_title(&block).unwrap_or(block))
        .collect();
    dehyphenate(&blocks.join("\n\n"))
}

pub fn split_blocks(page: &str) -> impl Iterator<Item = String> + '_ {
    page.split("\n\n")
        .map(|block| block.trim_matches('\n').to_string())
        .filter(|block| !block.trim().is_empty())
}

pub fn is_image(block: &str) -> bool {
    block
        .strip_prefix("![](")
        .is_some_and(|rest| rest.starts_with(IMAGE_URL_SCHEME))
}

/// pdf_oxide bolds each word separately (`**Ashish** **Vaswani**`).
fn merge_bold_runs(block: String) -> String {
    block.replace("** **", " ")
}

fn is_heading(block: &str) -> bool {
    block.starts_with('#')
}

/// The words of a short single-line block with page numbers replaced by `#`,
/// so headers that differ only by page number compare equal.
fn furniture_key(block: &str) -> Option<String> {
    if block.contains('\n') {
        return None;
    }
    let text = block.trim_start_matches('#').replace("**", "");
    let words: Vec<String> = text
        .split_whitespace()
        .map(|word| {
            if is_page_number(word) {
                "#".to_string()
            } else {
                word.to_lowercase()
            }
        })
        .collect();
    if words.is_empty() || words.len() > MAX_FURNITURE_WORDS {
        return None;
    }
    Some(words.join(" "))
}

fn is_page_number(word: &str) -> bool {
    let word = word.trim_matches(|c: char| !c.is_alphanumeric());
    !word.is_empty() && (word.chars().all(|c| c.is_ascii_digit()) || is_roman_numeral(word))
}

/// Strict form only, so ordinary words made of roman-numeral letters ("mild",
/// "civil") don't count.
fn is_roman_numeral(word: &str) -> bool {
    const NUMERALS: [(&str, u32); 13] = [
        ("m", 1000),
        ("cm", 900),
        ("d", 500),
        ("cd", 400),
        ("c", 100),
        ("xc", 90),
        ("l", 50),
        ("xl", 40),
        ("x", 10),
        ("ix", 9),
        ("v", 5),
        ("iv", 4),
        ("i", 1),
    ];
    let lower = word.to_ascii_lowercase();
    if word.len() > 8 || (word != lower && word != word.to_ascii_uppercase()) {
        return false;
    }
    let mut value = 0;
    let mut rest = lower.as_str();
    while let Some(&(numeral, n)) = NUMERALS
        .iter()
        .find(|(numeral, _)| rest.starts_with(numeral))
    {
        value += n;
        rest = &rest[numeral.len()..];
    }
    if !rest.is_empty() || value == 0 {
        return false;
    }
    // Greedy parsing accepts non-canonical spellings ("iiii", "vx"); writing
    // the value back out and comparing rejects them.
    let mut canonical = String::new();
    let mut remaining = value;
    for (numeral, n) in NUMERALS {
        while remaining >= n {
            canonical.push_str(numeral);
            remaining -= n;
        }
    }
    canonical == lower
}

fn is_page_number_key(key: &str) -> bool {
    key.split(' ')
        .all(|word| matches!(word, "#" | "page" | "of" | "-" | "|"))
}

/// The page's first and last [`EDGE_BLOCKS`] text blocks.
fn edge_indices(page: &[String]) -> Vec<usize> {
    let text: Vec<usize> = (0..page.len()).filter(|&i| !is_image(&page[i])).collect();
    let len = text.len();
    (0..len.min(EDGE_BLOCKS))
        .chain(len.saturating_sub(EDGE_BLOCKS).max(EDGE_BLOCKS)..len)
        .map(|i| text[i])
        .collect()
}

fn strip_page_furniture(pages: &mut [Vec<String>]) {
    if pages.len() < 2 {
        return;
    }
    let mut pages_with_key: HashMap<String, usize> = HashMap::new();
    for page in pages.iter() {
        let keys: HashSet<String> = edge_indices(page)
            .into_iter()
            .filter(|&i| !is_heading(&page[i]))
            .filter_map(|i| furniture_key(&page[i]))
            .collect();
        for key in keys {
            *pages_with_key.entry(key).or_default() += 1;
        }
    }
    for page in pages.iter_mut() {
        let furniture: HashSet<usize> = edge_indices(page)
            .into_iter()
            .filter(|&i| {
                furniture_key(&page[i]).is_some_and(|key| {
                    is_page_number_key(&key)
                        || (!is_heading(&page[i])
                            && key.chars().any(char::is_alphabetic)
                            && pages_with_key[&key] >= MIN_RUNNING_HEADER_PAGES)
                })
            })
            .collect();
        let mut index = 0;
        page.retain(|_| {
            index += 1;
            !furniture.contains(&(index - 1))
        });
    }
}

/// A single-line paragraph: not a heading, list, table, quote, code or image.
fn is_plain_paragraph(block: &str) -> bool {
    !block.contains('\n')
        && !is_image(block)
        && !block.starts_with(['#', '-', '*', '+', '|', '>', '`'])
        && !block.starts_with(|c: char| c.is_ascii_digit())
}

/// Rejoins a paragraph that a page break split in two, moving any images that
/// ended the first page after it.
fn join_pages(pages: Vec<Vec<String>>) -> Vec<String> {
    let mut blocks: Vec<String> = Vec::new();
    for page in pages {
        let mut page = page.into_iter();
        if let Some(first) = page.next() {
            let last_text = blocks.iter().rposition(|block| !is_image(block));
            match last_text.map(|i| &mut blocks[i]) {
                Some(previous) if continues(previous, &first) => {
                    if !previous.ends_with('-') {
                        previous.push(' ');
                    }
                    previous.push_str(&first);
                }
                _ => blocks.push(first),
            }
        }
        blocks.extend(page);
    }
    blocks
}

fn continues(previous: &str, next: &str) -> bool {
    is_plain_paragraph(previous)
        && is_plain_paragraph(next)
        && !previous.ends_with(['.', '!', '?', ':', ';', '"', '\u{201D}'])
        && next.starts_with(char::is_lowercase)
}

/// `**2.1 Related Work**` → `### 2.1 Related Work`. pdf_oxide only makes
/// headings from font size, and papers often set section titles in bold at
/// body size.
fn promote_section_title(block: &str) -> Option<String> {
    let inner = block.strip_prefix("**")?.strip_suffix("**")?;
    if inner.contains("**") || inner.contains('\n') {
        return None;
    }
    let (number, title) = inner.split_once(' ')?;
    let parts: Vec<&str> = number.trim_end_matches('.').split('.').collect();
    if !parts
        .iter()
        .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let title = title.trim();
    let words = title.split_whitespace().count();
    if words == 0
        || words > MAX_SECTION_TITLE_WORDS
        || title.ends_with('.')
        || !title.starts_with(char::is_uppercase)
    {
        return None;
    }
    let level = (parts.len() + 1).min(4);
    Some(format!("{} {} {}", "#".repeat(level), number, title))
}

/// pdf_oxide joins a word broken across lines at a hyphen but keeps the
/// hyphen, since it can't tell `representa-tion` from `pre-train`. The rest of
/// the document can: a hyphenated pair is joined when its unhyphenated form is
/// used at least as often elsewhere.
fn dehyphenate(text: &str) -> String {
    let mut words: HashMap<String, usize> = HashMap::new();
    let mut hyphenated: HashMap<String, usize> = HashMap::new();
    for run in letter_runs(text) {
        match run.split_once('-') {
            None => *words.entry(run.to_lowercase()).or_default() += 1,
            Some(_) => *hyphenated.entry(run.to_lowercase()).or_default() += 1,
        }
    }

    let verbatim = verbatim_ranges(text);
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (start, run) in letter_run_positions(text) {
        if verbatim.iter().any(|range| range.contains(&start)) || in_url(text, start) {
            continue;
        }
        let Some((head, tail)) = two_part_split(run) else {
            continue;
        };
        let joined = format!("{head}{tail}").to_lowercase();
        let joined_count = words.get(&joined).copied().unwrap_or(0);
        if joined_count > 0 && joined_count >= hyphenated[&run.to_lowercase()] {
            out.push_str(&text[last..start]);
            out.push_str(head);
            out.push_str(tail);
            last = start + run.len();
        }
    }
    out.push_str(&text[last..]);
    out
}

/// Byte ranges of link destinations (`](...)`) and code spans, which name
/// things rather than spell words.
fn verbatim_ranges(text: &str) -> Vec<std::ops::Range<usize>> {
    let mut ranges = Vec::new();
    let mut from = 0;
    while let Some(offset) = text[from..].find(['`', ']']) {
        let start = from + offset;
        let (open, close) = if text[start..].starts_with('`') {
            ("`", '`')
        } else if text[start..].starts_with("](") {
            ("](", ')')
        } else {
            from = start + 1;
            continue;
        };
        let body = start + open.len();
        match text[body..].find(close) {
            Some(end) => {
                ranges.push(start..body + end);
                from = body + end + 1;
            }
            // A stray opener: keep looking for later spans.
            None => from = body,
        }
    }
    ranges
}

/// Whether the whitespace-delimited token around `index` is a URL or email
/// address, including a link's visible text (pdf_oxide writes a bare URL as
/// `[https://…](https://…)`).
fn in_url(text: &str, index: usize) -> bool {
    let start = text[..index]
        .rfind(char::is_whitespace)
        .map_or(0, |i| i + 1);
    let end = text[index..]
        .find(char::is_whitespace)
        .map_or(text.len(), |i| index + i);
    let token = &text[start..end];
    token.contains("://") || token.contains("www.") || token.contains('@')
}

/// `head-tail` where both sides are letters and the tail is lowercase, so
/// compounds like `English-German` and chains like `state-of-the-art` stay.
fn two_part_split(run: &str) -> Option<(&str, &str)> {
    let (head, tail) = run.split_once('-')?;
    (!head.is_empty()
        && !tail.is_empty()
        && !tail.contains('-')
        && tail.starts_with(char::is_lowercase))
    .then_some((head, tail))
}

fn letter_runs(text: &str) -> impl Iterator<Item = &str> {
    letter_run_positions(text).map(|(_, run)| run)
}

/// Maximal runs of letters and hyphens, trimmed of hyphens at either end.
fn letter_run_positions(text: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut chars = text.char_indices().peekable();
    std::iter::from_fn(move || loop {
        let (start, _) = *chars.peek()?;
        let mut end = start;
        while let Some(&(i, c)) = chars.peek() {
            if !(c.is_alphabetic() || c == '-') {
                break;
            }
            end = i + c.len_utf8();
            chars.next();
        }
        if end == start {
            chars.next();
            continue;
        }
        let run = &text[start..end];
        let trimmed = run.trim_start_matches('-');
        let offset = run.len() - trimmed.len();
        let trimmed = trimmed.trim_end_matches('-');
        if !trimmed.is_empty() {
            return Some((start + offset, trimmed));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pages(pages: &[&str]) -> Vec<String> {
        pages.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn strips_page_numbers_and_running_headers() {
        let out = assemble(pages(&[
            "**Preface**\n\nFirst page text.\n\n**vii**",
            "**viii**\n\n**Preface**\n\nSecond page text.",
            "**Preface**\n\nThird page text.\n\n9",
        ]));
        assert_eq!(
            out,
            "First page text.\n\nSecond page text.\n\nThird page text."
        );
    }

    #[test]
    fn keeps_short_edge_blocks_that_repeat_on_too_few_pages() {
        let repeats = MIN_RUNNING_HEADER_PAGES - 1;
        let input: Vec<String> = (0..repeats)
            .map(|i| format!("Notes\n\nBody {i}."))
            .chain(std::iter::once("Other.".to_string()))
            .collect();
        assert_eq!(assemble(input).matches("Notes").count(), repeats);
    }

    #[test]
    fn keeps_repeated_headings_and_mid_page_numbers() {
        let page = "## Exercises\n\nIntro.\n\n42\n\nMore.\n\nEnd.";
        let input = vec![page.to_string(); MIN_RUNNING_HEADER_PAGES];
        let out = assemble(input);
        assert_eq!(
            out.matches("## Exercises").count(),
            MIN_RUNNING_HEADER_PAGES
        );
        assert_eq!(out.matches("42").count(), MIN_RUNNING_HEADER_PAGES);
    }

    #[test]
    fn single_page_keeps_everything() {
        assert_eq!(assemble(pages(&["Text.\n\n1"])), "Text.\n\n1");
    }

    #[test]
    fn rejoins_paragraph_split_by_page_break() {
        let out = assemble(pages(&[
            "Start of a sentence that runs\n\n12",
            "on to the next page.\n\nNew paragraph.",
        ]));
        assert_eq!(
            out,
            "Start of a sentence that runs on to the next page.\n\nNew paragraph."
        );
    }

    #[test]
    fn keeps_page_break_after_finished_sentence_or_before_capital() {
        let out = assemble(pages(&["Done.", "next starts lowercase."]));
        assert_eq!(out, "Done.\n\nnext starts lowercase.");
        let out = assemble(pages(&["No full stop", "Capitalised start."]));
        assert_eq!(out, "No full stop\n\nCapitalised start.");
        let out = assemble(pages(&["- a list item", "continues"]));
        assert_eq!(out, "- a list item\n\ncontinues");
    }

    #[test]
    fn finds_page_furniture_past_images_at_the_page_edges() {
        let out = assemble(pages(&[
            "Running Title\n\n![](pdf-image:0)\n\nFirst.",
            "Running Title\n\nSecond.\n\n![](pdf-image:1)",
            "Running Title\n\nThird.",
        ]));
        assert_eq!(
            out,
            "![](pdf-image:0)\n\nFirst.\n\nSecond.\n\n![](pdf-image:1)\n\nThird."
        );
    }

    #[test]
    fn rejoins_a_paragraph_across_images_ending_its_page() {
        let out = assemble(pages(&[
            "A sentence that runs\n\n![](pdf-image:0)",
            "on past the figure.\n\n![](pdf-image:1)",
            "continues nothing: an image is not a paragraph",
        ]));
        assert_eq!(
            out,
            "A sentence that runs on past the figure.\n\n![](pdf-image:0)\n\n![](pdf-image:1)\n\ncontinues nothing: an image is not a paragraph"
        );
    }

    #[test]
    fn merges_per_word_bold() {
        assert_eq!(
            assemble(pages(&["**Ashish** **Vaswani** wrote"])),
            "**Ashish Vaswani** wrote"
        );
    }

    #[test]
    fn promotes_numbered_bold_section_titles() {
        assert_eq!(
            assemble(pages(&["**1** **Introduction**"])),
            "## 1 Introduction"
        );
        assert_eq!(
            assemble(pages(&["**2.1** **Related** **Work**"])),
            "### 2.1 Related Work"
        );
        assert_eq!(
            assemble(pages(&["**1.2.3.4** **Deep**"])),
            "#### 1.2.3.4 Deep"
        );
    }

    #[test]
    fn leaves_bold_lines_that_are_not_section_titles() {
        for block in [
            "**2018** **was a good year.**",
            "**1.** **Introduction** Dynamic languages are",
            "**Abstract**",
            "**3** **apples**",
        ] {
            let merged = merge_bold_runs(block.to_string());
            assert_eq!(assemble(pages(&[block])), merged);
        }
    }

    #[test]
    fn dehyphenates_words_used_unhyphenated_elsewhere() {
        let out = dehyphenate("A representa-tion of the representation.");
        assert_eq!(out, "A representation of the representation.");
    }

    #[test]
    fn keeps_hyphens_the_document_uses() {
        // No unhyphenated "pretrain" anywhere.
        assert_eq!(dehyphenate("We pre-train it."), "We pre-train it.");
        // The hyphenated form is the more common one.
        let text = "fine-tune, fine-tune, finetune";
        assert_eq!(dehyphenate(text), text);
        // Compounds with a capitalised tail, and chains.
        let text = "English-German state-of-the-art englishgerman stateof";
        assert_eq!(dehyphenate(text), text);
    }

    #[test]
    fn dehyphenation_leaves_links_and_code_alone() {
        let text = "To recover, see [the docs](https://x.org/re-cover) or run `re-cover`.";
        assert_eq!(dehyphenate(text), text);
        let text = "A stray ` then recover and [a](https://x.org/re-cover).";
        assert_eq!(dehyphenate(text), text);
        let text =
            "recover at [https://re-cover.example](https://re-cover.example) or re-cover@x.org";
        assert_eq!(dehyphenate(text), text);
    }

    #[test]
    fn dehyphenation_handles_non_ascii_letters() {
        assert_eq!(
            dehyphenate("überset-zung übersetzung"),
            "übersetzung übersetzung"
        );
    }

    #[test]
    fn roman_numerals() {
        for numeral in ["i", "iv", "viii", "XIV", "mcmxc"] {
            assert!(is_roman_numeral(numeral), "{numeral}");
        }
        for word in ["civil", "mild", "iiii", "vx", "Xi", ""] {
            assert!(!is_roman_numeral(word), "{word}");
        }
    }
}
